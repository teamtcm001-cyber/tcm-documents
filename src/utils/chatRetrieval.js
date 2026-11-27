// Chat retrieval + grounding builder (pure functions: no React / Supabase imports, so
// everything here can be unit-tested in plain node).
//
// The chat server (api/chat.js) answers summary / content / status questions ONLY from
// the `grounding` object built here:
//   { projectBriefs, passages, notIndexed, truncated, [projectsTotal, projectsShown], [passageCoverage], [docsScan], [meetings] }
// Meeting minutes (type 'mom') are handled as SERIES of numbered meetings: each file name is parsed
// into { series, number, date } (parseMeetingName), meetings are ordered by number then date (never
// by upload date), the newest of every series is always read, every passage carries its series /
// number / meeting date, and `meetings` tells the model which meetings were read and which exist
// but were not.
// Policy this module enforces:
//   * PRIVACY: phone numbers and Thai national-ID numbers are scrubbed from passage text and
//     from every free-text brief field ("[เบอร์โทร]" / "[เลขบัตร]"). Briefs are built field by
//     field from an allow-list: no phone column, no recorder / user names.
//   * MONEY: the tracking data has no money fields and none are added. Amounts that appear
//     INSIDE a document passage (contract text, minutes) are sent as written - they are the
//     document's own content and are not scrubbed.
//   * bounded size (<= 6 briefs for named projects, <= 12 for portfolio questions, <= 14 passages, <= ~40k passage chars, each <= 4000),
//   * the context files are never mutated.

import { computeHealth, HEALTH_ORDER, STATUS_LABEL, OPEN_STATUSES, splitCoNames, fmtThaiDate, hasInstallments, statusLabel } from './tracking.js'

export const GROUNDING_LIMITS = {
  BRIEFS: 6, // named projects ("summarize project X")
  PORTFOLIO_BRIEFS: 12, // "which projects ..." questions: cover every project of a normal portfolio
  PASSAGES: 14,
  PASSAGE_CHARS: 4000,
  TOTAL_PASSAGE_CHARS: 40000,
  FILES: 8,
  INSTALLMENTS: 40,
  NOTE_CHARS: 300,
  STORED_TEXT_CAP: 50000, // content_text is cut at this length at storage time
  MEETINGS_PER_SERIES: 3, // newest N meetings of each series (default)
  MEETINGS_BUDGET: 6, // meeting files for an explicit meeting question
  MEETINGS_BUDGET_SUMMARY: 4, // meeting files for a whole-project summary (contract + TOR also need slots)
  MEETING_SERIES: 12, // series described in grounding.meetings
  MEETING_LIST: 12, // used / unread entries per series
  MEETING_NUMBERS: 300, // not-used meeting numbers per series
}

// ---------- text helpers ----------
const THAI = '\\u0E00-\\u0E7F'
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
const compact = (s) => norm(s).replace(/[\s\-_.,/()[\]]+/g, '')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isAsciiWord = (s) => /^[a-z0-9\-_ ]+$/.test(s)

function countOcc(hay, needle, cap = 5) {
  if (!needle) return 0
  let n = 0
  let i = 0
  while (n < cap && (i = hay.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
  }
  return n
}

// ---------- 1. project detection ----------
// Words that appear in many project names and say nothing about WHICH project.
const NAME_STOP = [
  'โครงการ', 'ก่อสร้าง', 'ปรับปรุง', 'ออกแบบ', 'ควบคุมงาน', 'จัดจ้าง', 'งานจ้าง', 'ที่ปรึกษา', 'การศึกษา', 'ศึกษา',
]
const NAME_STOP_LATIN = new Set(['project', 'construction', 'design', 'supervision', 'consultant', 'consulting', 'service', 'services'])
const NAME_STOP_SORTED = [...NAME_STOP].sort((a, b) => b.length - a.length)

const ALL_PROJECTS_RE =
  /ทุกโครงการ|ทั้งหมด|โครงการไหน|โครงการใด|โครงการอะไร|แต่ละโครงการ|ทุกงาน|all projects?|every project|each project|which projects?|across projects/i

function lcsLen(a, b) {
  if (!a || !b) return 0
  let best = 0
  let prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

function stripNameStops(s) {
  let out = s
  for (const w of NAME_STOP_SORTED) out = out.split(w).join(' ')
  return out
}

/**
 * Which project(s) does the query talk about?
 * @returns {{ projects: object[], allProjects: boolean }}  projects: up to 3, best first
 */
export function detectProjects(query, projects) {
  const q = norm(query)
  const allProjects = ALL_PROJECTS_RE.test(q)
  if (!q || !Array.isArray(projects) || !projects.length) return { projects: [], allProjects }

  const qc = compact(q)
  // query pieces left after removing generic words (used for the partial-name match)
  const qSegments = stripNameStops(q)
    .replace(/([a-z0-9])([฀-๿])/g, '$1 $2')
    .replace(/([฀-๿])([a-z0-9])/g, '$1 $2')
    .split(new RegExp(`[^a-z0-9${THAI}]+`))
    .map(compact)
    .filter((s) => s.length >= 4)
  const qTokens = new Set(q.split(new RegExp(`[^a-z0-9${THAI}]+`)).filter(Boolean))

  const scored = []
  for (const p of projects) {
    if (!p) continue
    const code = norm(p.code)
    const name = norm(p.name)
    let score = 0

    if (code.length >= 2) {
      const codeRe = isAsciiWord(code)
        ? new RegExp(`(^|[^a-z0-9])${escapeRe(code)}($|[^a-z0-9])`)
        : new RegExp(escapeRe(code))
      if (codeRe.test(q)) score = 100 + code.length
      else {
        const cc = compact(code)
        // "MRT PP" for "MRT-PP"; not when a longer code follows ("MRT-PP2")
        if (cc.length >= 4 && new RegExp(`(^|[^a-z0-9])${escapeRe(cc)}($|[^a-z0-9])`).test(qc)) score = 95 + cc.length
      }
    }

    if (!score && name) {
      const nc = compact(name)
      const nBare = compact(stripNameStops(name))
      if (nc.length >= 3 && qc.includes(nc)) score = 90 + Math.min(nc.length, 9)
      else if (nBare.length >= 4 && qc.includes(nBare)) score = 90 + Math.min(nBare.length, 9)
      else if (nBare.length >= 6) {
        let best = 0
        for (const seg of qSegments) best = Math.max(best, lcsLen(seg, nBare))
        if (best >= 6) score = best // partial name ("สายสีม่วง" of a longer name)
      }
      if (!score) {
        // a distinctive Latin word of the name written as its own word in the query
        for (const w of name.split(/[^a-z0-9]+/)) {
          if (w.length >= 4 && !NAME_STOP_LATIN.has(w) && qTokens.has(w)) {
            score = Math.max(score, 5 + w.length)
          }
        }
      }
    }
    if (score) scored.push({ project: p, score })
  }

  // "P06676-BRAC" typed in full must not also pull in the project coded "P06676"
  const codeHits = scored.filter((s) => s.score >= 95)
  const shadowed = (s) =>
    codeHits.some((o) => o !== s && norm(o.project.code).length > norm(s.project.code).length && norm(o.project.code).startsWith(norm(s.project.code)))
  scored.splice(0, scored.length, ...scored.filter((s) => !(s.score >= 95 && shadowed(s))))
  scored.sort((a, b) => b.score - a.score)
  // an exact code / full-name hit makes weaker partial hits irrelevant
  const strong = scored.filter((s) => s.score >= 90)
  const picked = (strong.length ? strong : scored).slice(0, 3).map((s) => s.project)
  return { projects: picked, allProjects }
}

// Follow-up questions ("ประชุมครั้งล่าสุดคุยเรื่องอะไร" right after talking about one project):
// the project is inherited ONLY from the immediately previous user question, else from the
// project(s) the previous bot answer was about (prevProjectIds).
export function detectProjectsFromHistory(history, projects, prevProjectIds = []) {
  const lastUser = [...(history || [])].reverse().find((m) => m && m.role === 'user' && m.text)
  if (lastUser) {
    const d = detectProjects(lastUser.text, projects)
    if (d.projects.length) return d.projects.slice(0, 2)
  }
  const ids = new Set((prevProjectIds || []).map(String))
  return ids.size ? (projects || []).filter((p) => ids.has(String(p.id))).slice(0, 2) : []
}

// A permit-checklist conversation ("เอกสารขออนุญาตก่อสร้าง") is going on in the last few turns.
const PERMIT_CONVO_RE = /ขออนุญาต|ใบอนุญาต|เอกสารอนุญาต|permit|แบบ ข\.1|แบบ น\.1/i
export function isPermitConversation(history, window = 6) {
  return (history || []).slice(-window).some((m) => m && PERMIT_CONVO_RE.test(String(m.text || '')))
}

// ---------- 2. does this question need grounding? ----------
// Summary / explanation / status / "what does the document say" wording.
const STRONG_RE = new RegExp(
  [
    'สรุป', 'เรื่องราว', 'ประวัติ', 'ความเป็นมา', 'ภาพรวม', 'ความคืบหน้า', 'คืบหน้า', 'สถานะ',
    'เป็นอย่างไร', 'เป็นยังไง', 'คุยเรื่อง', 'คุยกัน', 'พูดคุย', 'หารือ', 'ตกลง', 'ข้อสรุป', 'มติ',
    'ระบุว่า', 'ระบุไว้', 'ระบุเรื่อง', 'กำหนด', 'ค่าปรับ', 'งวด', 'เบิก', 'ขาด', 'ค้าง', 'เลยกำหนด',
    'ล่าช้า', 'ตามหลัง', 'อัป?เดต', 'อัพเดต', 'อธิบาย', 'ข้อตกลง', 'เงื่อนไข', 'ทำไม',
    'summar', 'overview', 'status', 'progress', 'explain', 'decid', 'discuss', 'agreed', 'history',
    'what (did|does|is|are|was)', 'why\\b', 'how (is|far)', 'installment', 'billing',
  ].join('|'),
  'i'
)
// Weaker question words: only count when the message is not about file metadata.
const QUESTION_RE = /ทำไม|เมื่อไร|เมื่อไหร่|ใคร|อย่างไร|ยังไง|อะไร|หรือไม่|หรือเปล่า|ไหม|หรือยัง|แค่ไหน|เท่าไร|\bwhy\b|\bwho\b|\bwhen\b|\bwhat\b|\bhow\b|\bwhich\b/i
// Document-type topics: asking about them without a "find / download" verb is a content question.
const TOPICAL_RE = /ประชุม|\bmom\b|minutes|meeting|สัญญา|contract|\btor\b|ขอบเขต|\beia\b|สิ่งแวดล้อม|addendum/i
// File-finding / downloading requests. STRICT ones win over the generic status / question words
// ("ดาวน์โหลดรายงานความคืบหน้าล่าสุด", "รายงานการประชุมครั้งที่ 3 อยู่ไฟล์ไหน" are NOT questions about content),
// unless the message also has an explicit summarize / explain verb.
const STRICT_FIND_RE =
  /^(?:ช่วย)?(?:หา|ค้นหา|ค้น|ดาวน์โหลด|ดาวโหลด|โหลด|download|find|search)|^ขอ(?:ไฟล์|เอกสาร|รายงาน|แบบ|สัญญา|mom|boq|eia|tor|ลิงก์|ลิ้งค์)|ไฟล์ไหน|อยู่ไฟล์|อยู่ในไฟล์|ไฟล์ล่าสุด|ไฟล์ทั้งหมด|มีไฟล์|กี่ไฟล์|จำนวนไฟล์|\bzip\b|รวมไฟล์|latest files?|all files/i
const EXPLICIT_RE = /สรุป|อธิบาย|คุยเรื่อง|คุยกัน|พูดคุย|หารือ|ระบุว่า|ระบุไว้|ระบุเรื่อง|ตกลง|เรื่องราว|summar|explain|discuss/i
// Weaker listing wording: only decides when no strong status / content word is present.
const SOFT_FIND_RE =
  /^(?:แสดง|เปิด|ดู|ส่ง|show|list|open|get|give me)|ล่าสุดทั้งหมด|ล่าสุดของ(?:ทุก|ทั้ง)|รายชื่อโครงการ|รายการโครงการ|โครงการทั้งหมด|มีโครงการอะไร|กี่ฉบับ|กี่รายการ/i
// Questions about the upload itself (when / who / how big), not about the document's content.
const UPLOAD_META_RE =
  /อัพ(?!เดต)|อัป(?!เดต)|upload|ขนาด|ใหญ่กว่า|เล็กกว่า|\d+\s*(mb|kb|gb)\b|เมื่อวาน|วันนี้|สัปดาห์(นี้|ที่แล้ว)|เดือน(นี้|ที่แล้ว)|ปีนี้|yesterday|\btoday\b|นามสกุล|\.(pdf|docx?|xlsx?)\b|ไฟล์ประเภท/i
// The permit-checklist feature ("ตรวจสอบเอกสารขออนุญาตก่อสร้าง") has its own flow.
const PERMIT_RE = /ขออนุญาต|ใบอนุญาต|permit/i
const SUMMARY_CORE_RE = /สรุป|เรื่องราว|ประวัติ|ระบุ|คุย|ความคืบหน้า|summar|history/i

/**
 * Should the client build grounding (project briefs + document passages) for this query?
 * @param {string} query
 * @param {{projects:object[], allProjects?:boolean}|object[]} [detected] result of detectProjects (or an array of projects)
 */
export function wantsGrounding(query, detected) {
  const q = norm(query)
  if (!q) return false
  const projs = Array.isArray(detected) ? detected : detected?.projects || []
  if (PERMIT_RE.test(q) && !SUMMARY_CORE_RE.test(q)) return false
  if (STRICT_FIND_RE.test(q) && !EXPLICIT_RE.test(q)) return false
  if (STRONG_RE.test(q)) return true
  if (SOFT_FIND_RE.test(q) || UPLOAD_META_RE.test(q)) return false
  if (QUESTION_RE.test(q) || TOPICAL_RE.test(q)) return true
  return projs.length > 0
}

// Status / tracking questions are answered from the briefs alone: no document text needed
// (saves tokens and the wait for the background text load).
const TRACKING_RE = /ความคืบหน้า|คืบหน้า|สถานะ|งวด|เบิก|เอกสารขาด|เอกสารครบ|ขาด|ค้าง|เลยกำหนด|ล่าช้า|ตามหลัง|อัป?เดต|อัพเดต|progress|status|billing|installment/i
const DOC_CONTENT_RE =
  /สรุป|เรื่องราว|ประวัติ|ประชุม|\bmom\b|สัญญา|\btor\b|ขอบเขต|\beia\b|ระบุ|คุย|ตกลง|มติ|ข้อสรุป|เงื่อนไข|ค่าปรับ|อธิบาย|ความเป็นมา|ภาพรวม|หารือ|summar|history|explain|discuss|meeting|minutes|contract/i

export function isTrackingOnly(query) {
  const q = norm(query)
  return TRACKING_RE.test(q) && !DOC_CONTENT_RE.test(q)
}

const fileCmp = (a, b) => {
  const d = String(b.date || '').localeCompare(String(a.date || ''))
  return d || String(b.name || '').localeCompare(String(a.name || ''))
}

// ---------- 2b. meeting minutes: series / number / year / date ----------
// "BDMS_MOM NO.42_Weekly Meeting 251105.pdf" -> series "BDMS Weekly", number 42, date 2025-11-05.
// "รายงานการประชุม ครั้งที่ 11/2568.pdf"     -> number 11, year 2025 (annual numbering: ordered by year, then number).
// Ordering is by (year,) number then meeting date, NEVER by upload date; the upload date is only a
// last-resort date and a series that has to rely on it is flagged (orderedByUpload).
// No look-behind regexes: this file also runs in older Safari.
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTHS_TH = [
  ['มกราคม', 'ม.ค.'], ['กุมภาพันธ์', 'ก.พ.'], ['มีนาคม', 'มี.ค.'], ['เมษายน', 'เม.ย.'], ['พฤษภาคม', 'พ.ค.'], ['มิถุนายน', 'มิ.ย.'],
  ['กรกฎาคม', 'ก.ค.'], ['สิงหาคม', 'ส.ค.'], ['กันยายน', 'ก.ย.'], ['ตุลาคม', 'ต.ค.'], ['พฤศจิกายน', 'พ.ย.'], ['ธันวาคม', 'ธ.ค.'],
]
const MONTH_ALT = [
  '(?:' + MONTHS_EN.join('|') + ')[a-z]*',
  ...MONTHS_TH.flatMap(([full, abbr]) => [full, abbr.replace(/\./g, '\\.?')]),
].join('|')
const DATE_TEXT_RE = new RegExp(`(\\d{1,2})\\s*[-.]?\\s*(${MONTH_ALT})\\s*[-,.]?\\s*(\\d{4}|\\d{2})(?!\\d)`, 'gi')
const DATE_YMD_RE = /(^|\D)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g
const DATE_DMY_RE = /(^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g
const DATE_8_RE = /(^|\D)(\d{4})(\d{2})(\d{2})(?!\d)/g
const DATE_6_RE = /(^|\D)(\d{2})(\d{2})(\d{2})(?!\d)/g
const VERSION_BEFORE_RE = /(?:\brev\.?|\bver\.?|\bversion|\bv)\s*$/i // "Rev 1.2.25" is a revision, not a date

function monthIndex(text) {
  const t = String(text).toLowerCase().replace(/\./g, '')
  const en = MONTHS_EN.findIndex((m) => t.startsWith(m))
  if (en >= 0) return en + 1
  const th = MONTHS_TH.findIndex(([f, a]) => t === f || t === a.replace(/\./g, ''))
  return th >= 0 ? th + 1 : 0
}

// Year from 4 digits (Gregorian or Buddhist era) or 2 digits (< 50 = 20yy, >= 50 = Buddhist 25yy).
function fullYear(raw) {
  const y = Number(raw)
  if (String(raw).length === 4) return y >= 2400 ? y - 543 : y
  return y < 50 ? 2000 + y : 1957 + y // 69 -> 2026
}

/** 'YYYY-MM-DD' when y/m/d is a real, plausible meeting date (2010 .. next year), else null. */
function validIso(y, m, d, now) {
  const yy = Number(y)
  const mm = Number(m)
  const dd = Number(d)
  if (!Number.isInteger(yy) || yy < 2010 || yy > now.getFullYear() + 1) return null
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= new Date(Date.UTC(yy, mm, 0)).getUTCDate())) return null
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

function lastMatch(re, text, fn) {
  re.lastIndex = 0
  let out = null
  let m
  while ((m = re.exec(text))) {
    const v = fn(m)
    if (v) out = v
    if (m[0] === '') re.lastIndex++
  }
  return out
}

// Strip control / zero-width / bidi characters and lone surrogates; cap very long names (head + tail).
const INVISIBLE_RE = /[\u0000-\u001F\u007F​-‏‪-‮⁠-⁩﻿�]/g
function cleanName(name) {
  let s = String(name ?? '')
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed()
  s = s.normalize('NFC').replace(INVISIBLE_RE, ' ')
  if (s.length > 400) s = s.slice(0, 200) + ' ' + s.slice(-200)
  return s
}
const FILE_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|txt|rtf|odt|csv|zip|rar|jpe?g|png|tiff?|dwg|msg)$/i

/**
 * Meeting date written in a file name: ISO / YYYYMMDD / D-M-Y / "5 Nov 2025" / "5 พ.ย. 68" / YYMMDD
 * (251105 = 2025-11-05; 690327 = 27 Mar 2026 in the Buddhist era). Returns 'YYYY-MM-DD' or null.
 * "Rev 1.2.25" is not a date; D.M.YY needs two-digit day and month.
 */
export function parseNameDate(name, now = new Date()) {
  const s = cleanName(name).replace(/_/g, ' ')
  return (
    lastMatch(DATE_YMD_RE, s, (m) => validIso(fullYear(m[2]), m[3], m[4], now)) ||
    lastMatch(DATE_8_RE, s, (m) => validIso(fullYear(m[2]), m[3], m[4], now)) ||
    lastMatch(DATE_DMY_RE, s, (m) => {
      if (VERSION_BEFORE_RE.test(s.slice(0, m.index + m[1].length))) return null
      if (m[4].length === 2 && (m[2].length !== 2 || m[3].length !== 2)) return null
      return validIso(fullYear(m[4]), m[3], m[2], now)
    }) ||
    lastMatch(DATE_TEXT_RE, s, (m) => {
      const mon = monthIndex(m[2])
      return mon ? validIso(fullYear(m[3]), mon, m[1], now) : null
    }) ||
    lastMatch(DATE_6_RE, s, (m) => validIso(fullYear(m[2]), m[3], m[4], now)) ||
    null
  )
}

const stripDates = (s) =>
  s.replace(DATE_TEXT_RE, ' ').replace(DATE_YMD_RE, '$1 ').replace(DATE_8_RE, '$1 ').replace(DATE_DMY_RE, '$1 ').replace(DATE_6_RE, '$1 ')

const WORD_ANCHOR_RE = /\bmom\b|\bminutes?\b|\bmeetings?\b|(?:รายงาน|บันทึก)?การประชุม/i
const NUM_NOT_A_DAY_RE = new RegExp(`^\\s*(?:[-/.]\\s*\\d|${MONTH_ALT}|\\d{4}(?!\\d))`, 'i') // "MOM 12 Nov", "MOM 12-11-2025", "MOM 5 2025"

// "/2568" (or "/68") right after the meeting number = annual numbering
function yearAfter(s, end, now) {
  const m = /^\s*\/\s*(\d{4}|\d{2})(?![\d/])/.exec(s.slice(end))
  if (!m) return null
  const y = fullYear(m[1])
  if (y < 2010 || y > now.getFullYear() + 1) return null
  return { year: y, text: m[1], end: end + m[0].length }
}

/**
 * The meeting number, taking the number that FOLLOWS ครั้งที่ / MOM / Minutes / Meeting (not just the first "NO.n"):
 * "Building No.2 MOM NO.5" -> 5. A bare "MOM n" is rejected when n is really a day of month ("MOM 12 Nov 2025").
 * @returns {{number:number, year:number|null, yearText:string, start:number, end:number}|null}
 */
function findMeetingNumber(s, now) {
  const anchor = WORD_ANCHOR_RE.exec(s)
  const afterAnchor = anchor ? anchor.index + anchor[0].length : 0
  const tries = [
    { re: /ครั้ง\s*ที่\s*[:-]?\s*0*(\d{1,3})(?!\d)/g },
    { re: /\b(?:mom|minutes?|meetings?)\s*[:-]?\s*(?:no\.?|#)\s*[:-]?\s*0*(\d{1,3})(?!\d)/gi },
    { re: /\bmom\s*[:-]?\s*0*(\d{1,3})(?!\d)/gi, bare: true },
    { re: /(?:\bno\.?|#)\s*[:-]?\s*0*(\d{1,3})(?!\d)/gi, from: afterAnchor },
  ]
  for (const { re, bare, from = 0 } of tries) {
    re.lastIndex = from
    let m
    while ((m = re.exec(s))) {
      const start = m.index
      let end = m.index + m[0].length
      const y = yearAfter(s, end, now)
      if (!y && bare && NUM_NOT_A_DAY_RE.test(s.slice(end))) continue
      if (y) end = y.end
      return { number: Number(m[1]), year: y ? y.year : null, yearText: y ? y.text : '', start, end }
    }
  }
  return null
}

const KIND_NOISE = new Set([
  'of', 'the', 'no', 'mom', 'minute', 'minutes', 'meeting', 'meetings', 'pdf', 'doc', 'docx', 'final', 'signed', 'draft', 'copy', 'scan',
  'scanned', 'revised', 'rev', 'ver', 'version', 'new', 'old', 'update', 'updated', 'ok', 'ฉบับ', 'แก้ไข', 'ลงนาม', 'ลงนามแล้ว', 'สมบูรณ์',
  'ฉบับสมบูรณ์', 'วันที่', 'ประจำวันที่', 'ที่', 'ครั้ง', 'ครั้งที่',
])
const MONTH_TOKEN_RE = new RegExp(`^(?:${MONTH_ALT})$`, 'i')
const ANCHOR_WORDS_RE = /(?:รายงาน|บันทึก)?(?:การ)?ประชุม|ครั้ง\s*ที่|\b(?:mom|minutes?|meetings?)\b/gi

// Words that name the series (organisation / code / meeting kind / Thai qualifier such as ออกแบบ, ก่อสร้าง).
// Order-independent: "Weekly Meeting NO.42 BDMS" and "BDMS MOM NO.43 Weekly" give the same tokens.
function seriesTokens(s) {
  const out = []
  for (let tok of s.split(/[\s,;:|()[\]{}"'“”_\\/]+/)) {
    tok = tok.replace(/^[-.]+|[-.]+$/g, '')
    if (!tok || !/[a-z0-9฀-๿]/i.test(tok)) continue
    if (/^[\d๐-๙.\-]+$/.test(tok) || /^\d+(?:st|nd|rd|th)$/i.test(tok) || /^(?:rev|ver|v)\.?\d*$/i.test(tok)) continue
    const lc = tok.toLowerCase()
    if (KIND_NOISE.has(lc) || MONTH_TOKEN_RE.test(tok)) continue
    out.push(tok.slice(0, 40))
    if (out.length >= 6) break
  }
  return out
}

/**
 * Parse a meeting-minutes file name.
 * series = the organisation / code / kind words of the name (order-independent key); number from
 * "MOM NO.n" / ครั้งที่ n / #n / "MOM n"; year from "n/2568" (annual numbering); date from the name,
 * else (last resort) the upload date. Never throws; a name with nothing usable gives series 'MOM'.
 * @param {string} name
 * @param {string} [uploadDate] files.date (ISO), used ONLY when the name has no date
 * @returns {{series:string, seriesKey:string, tokens:string[], number:number|null, year:number|null, yearText:string, date:string|null, dateSource:'name'|'upload'|null}}
 */
export function parseMeetingName(name, uploadDate = '', now = new Date()) {
  const s = cleanName(name).replace(FILE_EXT_RE, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  const num = findMeetingNumber(s, now)
  const rest = num ? s.slice(0, num.start) + ' ' + s.slice(num.end) : s
  const tokens = seriesTokens(stripDates(rest).replace(ANCHOR_WORDS_RE, ' '))
  const series = tokens.join(' ').slice(0, 60) || 'MOM'
  const seriesKey = tokens.length ? [...new Set(tokens.map((x) => x.toLowerCase()))].sort().join(' ') : 'mom'

  let date = parseNameDate(s, now)
  let dateSource = date ? 'name' : null
  if (!date && typeof uploadDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(uploadDate)) {
    date = uploadDate.slice(0, 10)
    dateSource = 'upload'
  }
  return {
    series, seriesKey, tokens, number: num ? num.number : null, year: num ? num.year : null, yearText: num ? num.yearText : '', date, dateSource,
  }
}

const cmpIso = (a, b) => (a && b ? (a < b ? -1 : a > b ? 1 : 0) : a ? 1 : b ? -1 : 0) // a missing date sorts first (oldest)
const uploadCmpAsc = (a, b) => String(a.file.date || '').localeCompare(String(b.file.date || '')) || String(a.file.name || '').localeCompare(String(b.file.name || ''))

/**
 * One entry per real meeting. Identity: (project, series, number, year); several files with the same identity are
 * versions of ONE meeting (newest upload represents it) unless their name dates differ. Without a number the
 * identity is the date written in the name, else the base name. (The base name alone is not enough: deriveBaseName
 * strips ISO dates, so "Weekly MOM 2025-11-05" and "...-12" would collapse.)
 * @param {{file:object, m:object}[]} parsed
 * @returns {{file:object, m:object, ids:string[]}[]}
 */
function dedupeMeetings(parsed) {
  const buckets = new Map()
  for (const it of parsed) {
    const { m, file } = it
    const id = m.number != null ? `n${m.number}|${m.year ?? ''}` : m.dateSource === 'name' ? `d${m.date}` : `b${file.baseName || file.name}`
    const key = `${file.projectId}|${m.seriesKey}|${id}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(it)
  }
  const groups = []
  for (const [key, list] of buckets) {
    const dates = [...new Set(list.filter((i) => i.m.dateSource === 'name').map((i) => i.m.date))].sort()
    if (key.includes('|n') && dates.length > 1) {
      // same number, different meeting dates written in the names: different meetings (undated files join the latest)
      const by = new Map(dates.map((d) => [d, []]))
      for (const i of list) by.get(i.m.dateSource === 'name' ? i.m.date : dates[dates.length - 1]).push(i)
      groups.push(...by.values())
    } else groups.push(list)
  }
  return groups.map((list) => {
    const rep = [...list].sort((a, b) => fileCmp(a.file, b.file))[0]
    let m = rep.m
    if (m.dateSource !== 'name') {
      const named = list.find((i) => i.m.dateSource === 'name')
      if (named) m = { ...m, date: named.m.date, dateSource: 'name' }
    }
    return { file: rep.file, m, ids: list.map((i) => String(i.file.id)) }
  })
}

/**
 * Order the meetings of ONE series oldest -> newest.
 *   'year-number': every meeting has number AND year ("ครั้งที่ 11/2568") -> (year, number).
 *   'number'     : every meeting has a number, no number repeats, and the numbers agree with the dates written in the names.
 *   'date'       : otherwise (numbers missing / restarted / contradicting the dates) -> by meeting date; orderedByUpload when
 *                  some meeting has no date in its name (upload date, or none, decides its place).
 * @param {{file:object, m:object}[]} items
 */
function orderSeries(items) {
  const byDate = [...items].sort(
    (a, b) => cmpIso(a.m.date, b.m.date) || (a.m.year ?? 0) - (b.m.year ?? 0) || (a.m.number ?? 0) - (b.m.number ?? 0) || uploadCmpAsc(a, b)
  )
  const dated = () => ({ asc: byDate, ordering: 'date', orderedByUpload: byDate.some((i) => i.m.dateSource !== 'name') })
  if (!items.length || !items.every((i) => i.m.number != null)) return dated()
  if (items.every((i) => i.m.year != null)) {
    const asc = [...items].sort((a, b) => a.m.year - b.m.year || a.m.number - b.m.number || cmpIso(a.m.date, b.m.date) || uploadCmpAsc(a, b))
    return { asc, ordering: 'year-number', orderedByUpload: false }
  }
  const byNumber = [...items].sort((a, b) => a.m.number - b.m.number || cmpIso(a.m.date, b.m.date) || uploadCmpAsc(a, b))
  if (new Set(items.map((i) => i.m.number)).size !== items.length) return dated() // a number repeats: numbering restarted
  if (byNumber.every((i) => i.m.dateSource === 'name')) {
    for (let k = 1; k < byNumber.length; k++) if (byNumber[k].m.date < byNumber[k - 1].m.date) return dated()
  }
  return { asc: byNumber, ordering: 'number', orderedByUpload: false }
}

/**
 * Group meeting files (type 'mom') into series per project (one entry per real meeting).
 * @returns {{key:string, projectId:string, series:string, ordering:'number'|'year-number'|'date', orderedByUpload:boolean,
 *   items:{file:object,m:object,ids:string[]}[], latestDate:string|null}[]}
 *   series newest first (by their latest meeting date); items oldest -> newest. The series label is the most common
 *   spelling among the files (ties: alphabetical), so it does not depend on input order.
 */
export function groupMeetings(files, now = new Date()) {
  const bySeries = new Map()
  for (const f of files || []) {
    if (!f || f.type !== 'mom') continue
    const m = parseMeetingName(f.name, f.date, now)
    const key = `${f.projectId}|${m.seriesKey}`
    if (!bySeries.has(key)) bySeries.set(key, { key, projectId: String(f.projectId ?? ''), parsed: [] })
    bySeries.get(key).parsed.push({ file: f, m })
  }
  const out = [...bySeries.values()].map((g) => {
    const spell = new Map()
    for (const p of g.parsed) spell.set(p.m.series, (spell.get(p.m.series) || 0) + 1)
    const series = [...spell].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0]
    const items = dedupeMeetings(g.parsed)
    const { asc, ordering, orderedByUpload } = orderSeries(items)
    const dates = asc.map((i) => i.m.date).filter(Boolean).sort()
    return { key: g.key, projectId: g.projectId, series, ordering, orderedByUpload, items: asc, latestDate: dates.length ? dates[dates.length - 1] : null }
  })
  out.sort((a, b) => cmpIso(b.latestDate, a.latestDate) || a.series.localeCompare(b.series) || a.key.localeCompare(b.key))
  return out
}

// Meeting numbers the question asks for: "ครั้งที่ 44", "NO.3", "#5", "ครั้งที่ 42-46" (range of <= 10).
export function requestedMeetingNumbers(query) {
  const q = norm(query)
  const out = new Set()
  const re = /(?:ครั้ง\s*ที่|\bno\.?|#|\bmeeting\s*no\.?)\s*[:-]?\s*0*(\d{1,3})(?:\s*(?:-|–|ถึง|to)\s*0*(\d{1,3}))?(?!\d)/g
  let m
  while ((m = re.exec(q))) {
    const a = Number(m[1])
    const b = m[2] != null ? Number(m[2]) : a
    if (b >= a && b - a < 10) for (let n = a; n <= b; n++) out.add(n)
    else out.add(a)
  }
  return [...out].slice(0, 10)
}

// Phrases that name meetings by number / count (removed from the keyword query).
const MEETING_COUNT_RE =
  /(?:ล่าสุด|latest|last|recent)\s*\d{1,2}\s*(?:ครั้ง|meetings?|ฉบับ)|\d{1,2}\s*ครั้ง\s*(?:ล่าสุด|ที่แล้ว|ย้อนหลัง)|(?:ครั้ง\s*ที่|\bno\.?|#)\s*[:-]?\s*\d{1,3}(?:\s*(?:-|–|ถึง|to)\s*\d{1,3})?(?:\s*\/\s*\d{2,4})?/g

// "ล่าสุด 5 ครั้ง" / "5 ครั้งล่าสุด" / "last 5 meetings": an explicit N, else null.
function requestedLatestCount(query) {
  const q = norm(query)
  const m = /(?:ล่าสุด|latest|last|recent)\s*(\d{1,2})\s*(?:ครั้ง|meetings?|ฉบับ)/.exec(q) || /(\d{1,2})\s*ครั้ง\s*(?:ล่าสุด|ที่แล้ว|ย้อนหลัง)/.exec(q)
  return m ? Math.min(6, Math.max(1, Number(m[1]))) : null
}

/**
 * Which meetings to read: the newest of EVERY series first, then the next newest of each series in turn,
 * up to `perSeries` per series and `budget` files overall. Meetings the question names by number are
 * taken right after the newest. Returns files in priority order.
 */
export function pickMeetings(files, { perSeries = GROUNDING_LIMITS.MEETINGS_PER_SERIES, budget = GROUNDING_LIMITS.MEETINGS_BUDGET, numbers = [], now = new Date() } = {}) {
  const groups = groupMeetings(files, now)
  const want = new Set(numbers)
  const cands = groups.map((g) => {
    const newestFirst = [...g.items].reverse()
    const req = newestFirst.filter((i) => i.m.number != null && want.has(i.m.number))
    const order = []
    const add = (i) => i && !order.includes(i) && order.push(i)
    add(newestFirst[0])
    req.forEach(add)
    newestFirst.forEach(add)
    return order.slice(0, Math.max(perSeries, Math.min(req.length + 1, 5)))
  })
  const out = []
  const taken = new Set()
  const take = (file) => {
    if (file && !taken.has(file) && out.length < budget) {
      taken.add(file)
      out.push(file)
    }
  }
  // 1) meetings the user NAMED by number come first, from every series (before the round-robin, so a
  //    project with many series cannot leave an explicitly requested meeting unread)
  if (want.size) {
    for (const g of groups) {
      for (const i of [...g.items].reverse()) if (i.m.number != null && want.has(i.m.number)) take(i.file)
    }
  }
  // 2) then the newest meeting of every series, round-robin
  for (let round = 0; out.length < budget; round++) {
    let any = false
    for (const c of cands) {
      if (c[round]) {
        any = true
        take(c[round].file)
      }
    }
    if (!any) break
  }
  return out
}

// ---------- 3. document selection ----------
const SUMMARY_RE = /สรุป|เรื่องราว|ประวัติ|ภาพรวม|ความเป็นมา|summar|overview|history|story/i
const TYPE_INTENTS = [
  { type: 'mom', re: /ประชุม|\bmom\b|minutes|meeting|คุยเรื่อง|คุยกัน|พูดคุย|หารือ|วาระ|มติ/i, limit: 3, byDate: true },
  { type: 'contract', re: /สัญญา|\bcontract\b|agreement|ค่าปรับ|ประกันผลงาน/i, limit: 2 },
  { type: 'tor', re: /\btor\b|ขอบเขต|scope of work|terms of reference/i, limit: 2 },
  { type: 'eia', re: /\beia\b|สิ่งแวดล้อม|อีไอเอ/i, limit: 2 },
  { type: 'qa', re: /q&a|addendum|ถาม.?ตอบ/i, limit: 2 },
]
const BOQ_ASKED_RE = /boq|ราคา|งบประมาณ|ประมาณการ/i


// Thai function / filler words that carry no search value (longest first when stripped).
const THAI_STOPS = [
  'สรุปเรื่องราว', 'เรื่องราว', 'สรุป', 'ประวัติ', 'ความเป็นมา', 'ภาพรวม', 'ความคืบหน้า', 'เป็นอย่างไร', 'อย่างไรบ้าง',
  'อย่างไร', 'เป็นยังไง', 'ยังไง', 'อะไรบ้าง', 'อะไร', 'ครั้งล่าสุด', 'ครั้งที่แล้ว', 'ล่าสุด', 'คุยเรื่อง', 'พูดถึง',
  'เกี่ยวกับ', 'ระบุว่า', 'ระบุเรื่อง', 'ระบุไว้', 'ระบุ', 'ของโครงการ', 'ในโครงการ', 'โครงการ', 'ทั้งหมด', 'หรือไม่',
  'หน่อย', 'ครับ', 'ค่ะ', 'บ้าง', 'เรื่อง', 'ว่า', 'ของ', 'ใน', 'จาก', 'ที่', 'ได้', 'ให้', 'ช่วย', 'หา', 'ขอ', 'ดู',
  'ไหม', 'คือ', 'มี', 'และ', 'หรือ', 'กับ', 'ทุก', 'คะ', 'นะ',
  // document-type words: handled by the type intents, useless as keywords
  'สัญญา', 'ประชุม', 'ขอบเขตงาน', 'ขอบเขต',
].sort((a, b) => b.length - a.length)
const LATIN_STOPS = new Set([
  'the', 'of', 'in', 'for', 'what', 'is', 'are', 'did', 'does', 'was', 'about', 'project', 'summary', 'summarize',
  'summarise', 'latest', 'last', 'please', 'and', 'to', 'an', 'me', 'tell', 'show', 'find', 'mom', 'tor', 'eia',
  'minutes', 'meeting', 'contract', 'all', 'how', 'why', 'who', 'when', 'which', 'with', 'from', 'that', 'this',
])

/**
 * Search terms from a (Thai or English) question. Thai has no spaces, so terms are what is
 * left after removing known filler words; very long leftovers also yield weak 6-char windows.
 * @returns {{term:string, weight:number}[]}
 */
export function queryTerms(query, { exclude = [] } = {}) {
  let q = norm(query)
  for (const ex of exclude.map(norm).filter(Boolean).sort((a, b) => b.length - a.length)) q = q.split(ex).join(' ')
  q = q.replace(/([a-z0-9])([฀-๿])/g, '$1 $2').replace(/([฀-๿])([a-z0-9])/g, '$1 $2')
  for (const sp of THAI_STOPS) q = q.split(sp).join(' ')
  const out = []
  const seen = new Set()
  const add = (term, weight) => {
    if (!seen.has(term)) {
      seen.add(term)
      out.push({ term, weight })
    }
  }
  for (const tok of q.split(new RegExp(`[^a-z0-9${THAI}]+`)).filter(Boolean)) {
    const thai = new RegExp(`[${THAI}]`).test(tok)
    if (thai ? tok.length < 3 : tok.length < 3 && !/\d/.test(tok)) continue
    if (!thai && LATIN_STOPS.has(tok)) continue
    add(tok, 1)
    if (thai && tok.length > 10) {
      for (let i = 0, n = 0; i + 6 <= tok.length && n < 4; i += 3, n++) add(tok.slice(i, i + 6), 0.3)
    }
  }
  return out.slice(0, 12)
}

function keywordScore(file, terms, lcCache) {
  if (!terms.length) return 0
  const name = norm(file.name)
  let text = lcCache.get(file.id)
  if (text === undefined) {
    text = file.contentText ? String(file.contentText).toLowerCase() : ''
    lcCache.set(file.id, text)
  }
  let score = 0
  for (const { term, weight } of terms) {
    if (name.includes(term)) score += 3 * weight
    if (text) score += countOcc(text, term, 5) * weight
  }
  return score
}

/**
 * Pick which files' text to read for this question (<= 8 files).
 *  - document-type intent: ประชุม/MOM -> meetings (see below); สัญญา -> latest 'contract'; TOR/ขอบเขต -> 'tor'; EIA -> 'eia'
 *  - "สรุปโครงการ" (no explicit type) -> meetings + latest 'contract' + 'tor' if present
 *  - plus files whose name / extracted text contain the query terms
 * MEETINGS (type 'mom') are never ranked by upload date: each file name is parsed into
 * series / number / date (parseMeetingName), the newest meeting of EVERY series is always taken, then the
 * next newest of each series in turn (3 per series by default, "ล่าสุด N ครั้ง" overrides), within a
 * budget of 6 files (4 for a whole-project summary). Meetings named by number ("ครั้งที่ 44") are taken too.
 * @param {string} query
 * @param {string[]} projectIds restrict to these projects (empty = whole library)
 * @param {object[]} files context files (normalizeFile objects); never mutated
 * @param {{exclude?: string[], max?: number, now?: Date}} [opts] exclude = project codes/names to ignore as keywords
 */
export function selectDocuments(query, projectIds, files, { exclude = [], max = GROUNDING_LIMITS.FILES, now = new Date() } = {}) {
  const q = norm(query)
  const ids = new Set((projectIds || []).map(String))
  const pool = (files || []).filter((f) => f && (ids.size === 0 || ids.has(String(f.projectId))))
  const chosen = new Map() // id -> { file, prio }
  const take = (f, prio) => {
    const cur = chosen.get(f.id)
    if (!cur || cur.prio < prio) chosen.set(f.id, { file: f, prio })
  }

  const explicit = TYPE_INTENTS.filter((t) => t.re.test(q))
  const summary = SUMMARY_RE.test(q)
  const perProject = (fn) => {
    const groups = ids.size ? [...ids].map((id) => pool.filter((f) => String(f.projectId) === id)) : [pool]
    groups.forEach(fn)
  }
  const pickType = (group, type, limit, byDate, prio) => {
    let list = group.filter((f) => f.type === type)
    // revisions of the same document / meeting (same base name) take ONE slot: the newest upload
    const newest = new Map()
    for (const f of list) {
      const k = `${f.projectId}|${f.baseName || f.name}`
      const cur = newest.get(k)
      if (!cur || fileCmp(f, cur) < 0) newest.set(k, f)
    }
    list = [...newest.values()]
    if (!byDate) {
      // versions of one document: the latest first, then newest
      list = [...list.filter((f) => f.isLatest).sort(fileCmp), ...list.filter((f) => !f.isLatest).sort(fileCmp)]
    } else {
      list = [...list].sort(fileCmp)
    }
    list.slice(0, limit).forEach((f, i) => take(f, prio - i))
  }
  // meetings: per series, never by upload date. `reserve` = slots the other document types need.
  const wantNo = requestedMeetingNumbers(q)
  const latestN = requestedLatestCount(q)
  const pickMom = (group, reserve, prio, defaultBudget) => {
    const seriesCount = groupMeetings(group, now).length
    let budget = Math.max(1, Math.min(defaultBudget, max - reserve))
    if (latestN) budget = Math.max(1, Math.min(max - reserve, latestN * seriesCount))
    pickMeetings(group, { perSeries: latestN || GROUNDING_LIMITS.MEETINGS_PER_SERIES, budget, numbers: wantNo, now }).forEach((f, i) =>
      take(f, prio - i * 0.01)
    )
  }

  if (explicit.length) {
    perProject((group) => {
      const reserve = explicit.filter((t) => t.type !== 'mom').reduce((n, t) => n + t.limit, 0)
      explicit.forEach((t) => {
        if (t.type === 'mom') pickMom(group, reserve, 100, GROUNDING_LIMITS.MEETINGS_BUDGET)
        else pickType(group, t.type, t.limit, t.byDate, 100)
      })
    })
  } else if (summary) {
    perProject((group) => {
      pickMom(group, 2, 90, GROUNDING_LIMITS.MEETINGS_BUDGET_SUMMARY)
      pickType(group, 'contract', 1, false, 89)
      pickType(group, 'tor', 1, false, 88)
    })
  }

  // keyword-scored files
  // "ครั้งที่ 3" / "NO.3" / "ล่าสุด 2 ครั้ง" select meetings (above); the bare digits are not search keywords
  const keywordQ = explicit.some((t) => t.type === 'mom') ? q.replace(MEETING_COUNT_RE, ' ') : q
  const terms = queryTerms(keywordQ, { exclude })
  if (terms.length) {
    const lcCache = new Map()
    const boqOk = BOQ_ASKED_RE.test(q)
    const scored = []
    for (const f of pool) {
      if (chosen.has(f.id)) continue
      if (f.type === 'boq' && !boqOk) continue // price lists: only on explicit request (no money in grounding by default)
      const s = keywordScore(f, terms, lcCache)
      if (s >= 2) scored.push({ f, s: s + (f.isLatest ? 0.5 : 0) })
    }
    scored.sort((a, b) => b.s - a.s || fileCmp(a.f, b.f))
    scored.slice(0, max).forEach(({ f, s }) => take(f, Math.min(80, s)))
  }

  return [...chosen.values()]
    .sort((a, b) => b.prio - a.prio || fileCmp(a.file, b.file))
    .slice(0, max)
    .map((c) => c.file)
}

// ---------- 4. passages ----------
const THAI_MARK = /[ัิ-ฺ็-๎]/ // vowels above/below + tone marks: never start a chunk
const THAI_LEAD = /[เ-ไ]/ // leading vowels: never end a chunk

/** Split into ~size chunks, breaking on newline/space (any char when none within `window`). */
export function chunkText(text, size = 1500, window = 200) {
  const s = String(text ?? '')
  const out = []
  const n = s.length
  let pos = 0
  while (pos < n) {
    let end = Math.min(pos + size, n)
    if (end < n) {
      const lo = Math.max(pos + 1, end - window)
      let br = -1
      for (let i = end; i > lo; i--) {
        if (s[i - 1] === '\n') {
          br = i
          break
        }
      }
      if (br < 0) {
        for (let i = end; i > lo; i--) {
          if (s[i - 1] === ' ' || s[i - 1] === '\t') {
            br = i
            break
          }
        }
      }
      if (br > 0) end = br
      else {
        // arbitrary cut: do not strand a Thai mark / leading vowel / half a surrogate pair
        let guard = 0
        while (
          end - 1 > pos &&
          guard++ < 4 &&
          (THAI_MARK.test(s[end]) || THAI_LEAD.test(s[end - 1]) || (s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff))
        ) {
          end--
        }
      }
    }
    const piece = s.slice(pos, end).trim()
    if (piece) out.push({ text: piece, start: pos })
    pos = end
  }
  return out
}

const cleanText = (t) =>
  String(t ?? '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')

// Codes / form numbers / section numbers / drawing numbers that must survive trimming:
// อ.1 ข.1 ค.1 น.1, มาตรา 39 ทวิ, แบบ ข.1, NO.3, Rev B, A-101, ข้อ 4.2, 1.2.3 ...
const CODE_RE =
  /[ก-ฮ]\.\s?[0-9๐-๙]+|มาตรา\s*[0-9๐-๙]+|ข้อ\s*[0-9๐-๙]+|\bno\.?\s*[0-9]+|\brev\.?\s*[a-z0-9]+|\b[a-z]{1,5}[-_/]?[0-9]{2,}|[0-9]+(?:\.[0-9]+)+/i
const HAS_DIGIT_RE = /[0-9๐-๙]/
const NL = String.fromCharCode(10)

// Sentence-ish units of a passage: lines, and long lines cut after a full stop that follows a word of 4+ chars
// (so "อ.1", "NO. 3", "ม.ค. 69" are never split). One linear scan per line (no backtracking regex).
function passageUnits(text) {
  const units = []
  const isSp = (c) => c === ' ' || c === '\t'
  for (const ln of String(text).split(NL)) {
    if (ln.length <= 300) {
      units.push(ln)
      continue
    }
    let last = 0
    let run = 0 // length of the current run of non-space, non-dot characters
    for (let i = 0; i < ln.length; i++) {
      const c = ln[i]
      if (isSp(c)) run = 0
      else if (c === '.' || c === ';' || c === '!' || c === '?') {
        const next = ln[i + 1]
        if (run >= 4 && isSp(next)) {
          let j = i + 1
          while (j < ln.length && isSp(ln[j])) j++
          if (j < ln.length) {
            units.push(ln.slice(last, i + 1))
            last = j
            i = j - 1
          }
        }
        run = 0
      } else run++
    }
    units.push(ln.slice(last))
  }
  return units.filter((u) => u.trim())
}

/**
 * Cut a passage to `maxChars` WITHOUT losing the sentences that carry codes / numbers: filler (no code,
 * no digit, no query term) is dropped first (last first), then sentences with plain numbers / query terms,
 * and sentences with a code / form / section number go last. Dropped stretches are marked "…".
 * Text that fits is returned unchanged. O(n log n) in the number of sentences.
 */
export function trimPassage(text, maxChars, terms = []) {
  const t = String(text ?? '')
  if (t.length <= maxChars) return t
  const units = passageUnits(t)
  const lcTerms = (terms || []).map((x) => String(x.term || '').toLowerCase()).filter(Boolean)
  const rank = (u) => (CODE_RE.test(u) ? 3 : lcTerms.some((w) => u.toLowerCase().includes(w)) || HAS_DIGIT_RE.test(u) ? 2 : 1)
  const items = units.map((u, i) => ({ u, i, r: rank(u) }))
  // drop order: lowest rank first, later units first
  const order = [...items].sort((a, b) => a.r - b.r || b.i - a.i)
  const rankOfDrop = new Array(items.length)
  order.forEach((it, k) => (rankOfDrop[it.i] = k))
  // size when the first k units of `order` are dropped
  const size = (k) => {
    let n = 0
    let gap = false
    for (const it of items) {
      if (rankOfDrop[it.i] >= k) {
        n += it.u.length + 1 + (gap ? 2 : 0)
        gap = false
      } else gap = true
    }
    return n + (gap ? 2 : 0)
  }
  // fewest drops that fit; the last unit is never dropped (it is hard-cut below instead)
  let lo = 0
  let hi = items.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (size(mid) <= maxChars) hi = mid
    else lo = mid + 1
  }
  const out = []
  let gap = false
  for (const it of items) {
    if (rankOfDrop[it.i] >= lo) {
      if (gap && out.length) out.push('…')
      out.push(it.u)
      gap = false
    } else gap = true
  }
  if (gap) out.push('…')
  const joined = out.join(NL)
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars)
}

/**
 * Best 1-3 chunks of one file for this query. Pure: `file` is not modified.
 * @param {object} file
 * @param {string} query
 * @param {{maxChars?:number, perFile?:number, chunkSize?:number, positional?:boolean, terms?:{term:string,weight:number}[], projectCode?:string}} [opts]
 *   positional: prefer the beginning (agenda / attendees / decisions) - MOM and summary questions
 *   Meeting files (type 'mom') also get series / meetingNo / meetingDate / meetingDateSource on every passage.
 * @returns {{fileId,fileName,projectCode,type,date,text:string,score:number,start:number}[]} in document order
 */
export function extractPassages(file, query, opts = {}) {
  const maxChars = Math.min(opts.maxChars || GROUNDING_LIMITS.PASSAGE_CHARS, GROUNDING_LIMITS.PASSAGE_CHARS)
  const perFile = Math.max(1, Math.min(opts.perFile || 2, 3))
  const raw = cleanText(file?.contentText)
  if (!raw.trim()) return []
  // text read by OCR (src/utils/ocr.js OCR_MARK): every passage of the file says so; "OCR found nothing" = no passage
  const isOcr = raw.startsWith('[[OCR]]')
  if (isOcr && !raw.replace(/^\[\[OCR\]\][^\n]*/, '').replace(/\(ไม่พบข้อความในภาพ\)/, '').trim()) return []
  const terms = opts.terms || queryTerms(query)
  const positional = opts.positional ?? (file?.type === 'mom' || SUMMARY_RE.test(norm(query)))
  const chunks = chunkText(raw, Math.min(opts.chunkSize || 1500, maxChars))

  const scored = chunks.map((c, idx) => {
    const lc = c.text.toLowerCase()
    let s = 0
    for (const { term, weight } of terms) s += Math.min(countOcc(lc, term, 3), 3) * weight * (1 + Math.min(term.length, 8) / 8)
    if (positional) s += [3, 1.5, 0.75][idx] || 0
    else s += 0.1 / (idx + 1) // tie-break: earlier first
    return { ...c, idx, score: s }
  })
  const best = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx)
  // always at least the best chunk; further chunks must have actually matched something
  const keep = best.filter((c, i) => i === 0 || c.score >= 1).slice(0, perFile)
  keep.sort((a, b) => a.start - b.start)
  const mt = file?.type === 'mom' ? parseMeetingName(file.name, file.date, opts.now || new Date()) : null
  return keep.map((c) => ({
    fileId: file.id,
    fileName: file.name,
    projectCode: opts.projectCode || '',
    type: file.type || 'other',
    date: file.date || '',
    ...(mt ? { series: mt.series, meetingNo: mt.number, meetingYear: mt.yearText, meetingDate: mt.date, meetingDateSource: mt.dateSource } : {}),
    ...(isOcr ? { ocr: true } : {}),
    text: trimPassage(scrubText(c.text), maxChars, terms),
    score: c.score,
    start: c.start,
  }))
}

/**
 * Passages for several files within the overall budget, with pids P1..Pn.
 * Breadth first: every file gets its best chunk before any file gets a second one.
 * Output order = file order (the priority order from selectDocuments), then position in the file;
 * meeting minutes come after the other documents, grouped by series (newest series first) and read
 * OLDEST -> NEWEST inside a series (by number, then date), so a later meeting is read after the one it may change.
 * Passages of meeting files also carry series / meetingNo / meetingDate / meetingDateSource.
 * @returns {{pid,fileId,fileName,projectCode,type,date,text,series?,meetingNo?,meetingDate?,meetingDateSource?}[]}
 */
export function buildPassages(files, query, opts = {}) {
  const {
    projects = [],
    maxPassages = GROUNDING_LIMITS.PASSAGES,
    maxTotalChars = GROUNDING_LIMITS.TOTAL_PASSAGE_CHARS,
    maxChars = GROUNDING_LIMITS.PASSAGE_CHARS,
    exclude = [],
    now = new Date(),
  } = opts
  const codeById = new Map(projects.map((p) => [String(p.id), p.code]))
  const terms = opts.terms || queryTerms(query, { exclude })
  const summaryQ = SUMMARY_RE.test(norm(query))
  const perFile = opts.perFile || (summaryQ ? 3 : 2)

  const cands = (files || []).map((f) =>
    extractPassages(f, query, {
      maxChars,
      perFile,
      terms,
      positional: f.type === 'mom' || summaryQ,
      projectCode: codeById.get(String(f.projectId)) || '',
      now,
    })
  )
  const picked = [] // { fi, c }
  let total = 0
  for (let round = 0; round < perFile && picked.length < maxPassages; round++) {
    for (let fi = 0; fi < cands.length && picked.length < maxPassages; fi++) {
      // candidates are in document order; use the round-th best by score
      const ranked = [...cands[fi]].sort((a, b) => b.score - a.score || a.start - b.start)
      const c = ranked[round]
      if (!c) continue
      let text = c.text
      const room = maxTotalChars - total
      if (room < 600) continue
      if (text.length > room) text = trimPassage(text, room, terms)
      total += text.length
      picked.push({ fi, c: { ...c, text } })
    }
  }
  // meeting order: series (newest first), then oldest -> newest inside the series
  // (ranks and series labels come from the whole scope, so they match grounding.meetings)
  const meetingRank = new Map() // fileId -> [seriesIdx, itemIdx, series label]
  groupMeetings(opts.scopeFiles || files, now).forEach((g, gi) =>
    g.items.forEach((it, ii) => it.ids.forEach((id) => meetingRank.set(id, [gi, ii, g.series])))
  )
  const rankOf = (c) => meetingRank.get(String(c.fileId))
  picked.sort((a, b) => {
    const ra = rankOf(a.c)
    const rb = rankOf(b.c)
    if (!ra !== !rb) return ra ? 1 : -1 // other documents first
    if (ra) return ra[0] - rb[0] || ra[1] - rb[1] || a.fi - b.fi || a.c.start - b.c.start
    return a.fi - b.fi || a.c.start - b.c.start
  })
  return picked.map(({ c }, i) => ({
    pid: `P${i + 1}`,
    fileId: c.fileId,
    fileName: c.fileName,
    projectCode: c.projectCode,
    type: c.type,
    date: c.date,
    ...(c.series
      ? { series: rankOf(c)?.[2] || c.series, meetingNo: c.meetingNo, meetingYear: c.meetingYear, meetingDate: c.meetingDate, meetingDateSource: c.meetingDateSource }
      : {}),
    ...(c.ocr ? { ocr: true } : {}),
    text: c.text,
  }))
}

/**
 * Which meetings were read and which exist but were not: one entry per series (per project) of the scope,
 * emitted only when at least one meeting file was selected. A meeting counts once however many versions of
 * its file exist (see groupMeetings).
 *   used   = selected AND text sent (oldest -> newest), unread = selected but no text reached the model,
 *   notUsed = numbers of the meetings that exist but were not selected (ordering 'number': numbers only).
 *   When the series is NOT ordered by plain number (ordering 'year-number' / 'date': annual numbering, restarted or
 *   missing numbers) bare numbers would be ambiguous, so the meetings that were not read are listed as
 *   notUsedItems [{no, year, date, dateSource, fileName}] (newest 30; notUsedTotal = how many in all) and notUsed is [].
 *   orderedByUpload = the order of the series depends on upload dates (or on files with no date at all).
 * Series with a selected meeting come first, then the cap of MEETING_SERIES applies.
 * @param {object[]} scopeFiles  files of the asked projects (all of them, not only the selected)
 * @param {object[]} selected    files chosen by selectDocuments
 * @param {{fileId:any}[]} passages passages that will be sent
 * @param {object[]} projects
 * @returns {{projectCode:string, series:string, ordering:'number'|'year-number'|'date', orderedByUpload:boolean, total:number,
 *   used:{no:number|null,year:string,date:string|null,dateSource:string|null,fileName:string}[], unread:{no,year,date,dateSource,fileName}[],
 *   notUsed:number[], notUsedItems:{no,year,date,dateSource,fileName}[], notUsedTotal:number, notUsedUnnumbered:number}[]}
 */
export function buildMeetingsInfo(scopeFiles, selected, passages, projects = [], now = new Date()) {
  const selIds = new Set((selected || []).filter((f) => f && f.type === 'mom').map((f) => String(f.id)))
  if (!selIds.size) return []
  const readIds = new Set((passages || []).map((p) => String(p.fileId)))
  const codeById = new Map((projects || []).map((p) => [String(p.id), p.code || p.name || '']))
  const L = GROUNDING_LIMITS
  const NOT_USED_ITEMS = 30
  const entries = groupMeetings(scopeFiles, now).map((g) => {
    const entry = (it) => ({ no: it.m.number, year: it.m.yearText || '', date: it.m.date, dateSource: it.m.dateSource, fileName: it.file.name || '' })
    const isSel = (it) => it.ids.some((id) => selIds.has(id))
    const isRead = (it) => it.ids.some((id) => readIds.has(id) && selIds.has(id))
    const used = g.items.filter(isRead)
    const unread = g.items.filter((it) => isSel(it) && !isRead(it))
    const rest = g.items.filter((it) => !isSel(it))
    const plain = g.ordering === 'number'
    return {
      projectCode: String(codeById.get(g.projectId) || ''),
      series: g.series,
      ordering: g.ordering,
      orderedByUpload: g.orderedByUpload,
      total: g.items.length,
      used: used.slice(-L.MEETING_LIST).map(entry),
      unread: unread.slice(-L.MEETING_LIST).map(entry),
      notUsed: plain ? rest.filter((it) => it.m.number != null).map((it) => it.m.number).slice(0, L.MEETING_NUMBERS) : [],
      notUsedItems: plain ? [] : rest.slice(-NOT_USED_ITEMS).map(entry),
      notUsedTotal: rest.length,
      notUsedUnnumbered: plain ? rest.filter((it) => it.m.number == null).length : 0,
      _selected: used.length + unread.length > 0,
    }
  })
  // filter first, then cap: a series with a selected meeting is never dropped by the cap
  return [...entries.filter((e) => e._selected), ...entries.filter((e) => !e._selected)]
    .slice(0, L.MEETING_SERIES)
    .map(({ _selected, ...e }) => e)
}

/** notIndexed: selected files with no extracted text. truncated: stored text hit the 50,000-char cut. */
export function flagUnreadable(files) {
  const notIndexed = []
  const truncated = []
  for (const f of files || []) {
    const len = (f.contentText || '').trim().length
    if (!len) notIndexed.push({ fileId: f.id, fileName: f.name })
    else if ((f.contentText || '').length >= GROUNDING_LIMITS.STORED_TEXT_CAP) truncated.push({ fileId: f.id, fileName: f.name })
  }
  return { notIndexed: notIndexed.slice(0, 30), truncated: truncated.slice(0, 30) }
}

// ---------- 5. project briefs (tracking data, no money / phones / user names) ----------
// Digits: ASCII or Thai (๐-๙). Matches are guarded against neighbouring digits by a captured
// prefix instead of a look-behind (older Safari).
const DG = '0-9๐-๙'
const ID_RE = new RegExp(String.raw`(^|[^${DG}])([${DG}][\s-]?[${DG}]{4}[\s-]?[${DG}]{5}[\s-]?[${DG}]{2}[\s-]?[${DG}])(?![${DG}])`, 'g')
const PHONE_RE = new RegExp(
  String.raw`(^|[^${DG}])(` +
    // +66 81 234 5678 / 66-81-234-5678 / 0066 ...
    String.raw`(?:\+66|0066|66(?=[\s.-]))[\s.-]?\(?[0๐]?\)?[\s.-]?[1-9๑-๙][${DG}]?[\s.-]?[${DG}]{3}[\s.-]?[${DG}]{4}` +
    '|' +
    // 081-234-5678, 08-1234-5678, (081) 234-5678, 081.234.5678, 0812345678, 02-123-4567
    String.raw`\(?[0๐][${DG}]{1,2}\)?[\s.-]?[${DG}]{3,4}[\s.-]?[${DG}]{4}` +
    String.raw`)(?:\s*(?:ต่อ|ext\.?|extension|#)\s*[${DG}]{1,5})?(?![${DG}])`,
  'gi'
)
/** Replace phone numbers and 13-digit Thai ID numbers (ASCII or Thai digits) with placeholders. */
export function scrubText(text) {
  return String(text ?? '')
    .replace(ID_RE, '$1[เลขบัตร]')
    .replace(PHONE_RE, '$1[เบอร์โทร]')
}
function scrub(s, max) {
  if (s == null) return null
  const t = scrubText(s).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)
const numOrNull = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function briefInstallment(i) {
  const status = i.status || ''
  return {
    no: numOrNull(i.installment_no),
    title: scrub(i.title, 200),
    status,
    statusLabel: STATUS_LABEL[status] || status,
    plannedBillDate: isoDate(i.planned_bill_date),
    billedDate: isoDate(i.billed_date),
    docs: {
      state: i.docs_state || null,
      attached: numOrNull(i.required_docs_attached) ?? 0,
      total: numOrNull(i.required_docs_total) ?? 0,
    },
    note: scrub(i.note, GROUNDING_LIMITS.NOTE_CHARS),
    statusNote: scrub(i.status_note, GROUNDING_LIMITS.NOTE_CHARS),
  }
}

// An installment worth a place in a cross-project brief.
const needsAttention = (i) =>
  OPEN_STATUSES.includes(i.status) || i.is_overdue === true || i.docs_state === 'missing'

// "Documents still missing": a required checklist item has no file and the installment is not
// closed out (paid / approved / cancelled). Applies to ANY such installment, not only the next one.
const CLOSED_OUT = ['paid', 'approved', 'cancelled']
export const hasMissingDocsRaw = (i) => i?.docs_state === 'missing' && !CLOSED_OUT.includes(i.status)
const hasMissingDocsBrief = (i) => i?.docs?.state === 'missing' && !CLOSED_OUT.includes(i.status)

/**
 * Brief for the chat: only allow-listed fields are copied (never phones, recorder names or money).
 * @param {object} project   context project ({id, code, name, ...})
 * @param {object|null} trackingRow project_tracking_overview row (+ ready_to_bill_days), null if tracking is unavailable
 * @param {object[]} installments installment_summary rows
 * @param {{onlyAttention?: boolean, installmentsFailed?: boolean}} [opts] cross-project mode: only open / overdue / missing-docs installments.
 *   installmentsFailed: the installment read failed (the brief then says trackingAvailable:false)
 * `trackingAvailable:false` is emitted when the overview row is missing or the installment read failed,
 * so "no installments" can never be mistaken for "could not load".
 * `noInstallments:true` (boolean, only when set) = the project is switched to "no billing installments"
 * (overview row has_installments === false): no installments are listed even if some are still stored.
 */
export function buildProjectBrief(project, trackingRow, installments = [], { onlyAttention = false, installmentsFailed = false } = {}) {
  const row = trackingRow || null
  const p = project || {}
  const names = splitCoNames(row?.project_co ?? p.project_co)
    .map((n) => scrub(n, 80))
    .filter(Boolean)
  const start = isoDate(row?.start_date ?? p.start_date)
  const end = isoDate(row?.end_date ?? p.end_date)

  let progress = null
  if (row) {
    const health = computeHealth(row)
    progress = {
      percent: numOrNull(row.percent_complete),
      asOf: isoDate(row.progress_as_of),
      timeElapsedPct: numOrNull(row.time_elapsed_pct),
      health: health.level,
      reasons: health.reasons,
    }
  }

  const noBilling = !!row && !hasInstallments(row)
  let inst = !noBilling && Array.isArray(installments) ? [...installments] : []
  inst.sort((a, b) => (a.installment_no || 0) - (b.installment_no || 0))
  if (onlyAttention) inst = inst.filter(needsAttention)

  const brief = {
    projectId: p.id ?? row?.project_id ?? null,
    code: p.code ?? row?.project_code ?? null,
    name: p.name ?? row?.project_name ?? null,
    status: statusLabel(row?.project_status ?? p.status ?? null),
    projectCo: names.length ? names.join(', ') : null,
    contract: start || end ? { start, end } : null,
    progress,
    installments: inst.slice(0, GROUNDING_LIMITS.INSTALLMENTS).map(briefInstallment),
  }
  if (noBilling) brief.noInstallments = true
  // a "no installments" project never needed its installments, so a failed read of them is irrelevant
  else if (!row || installmentsFailed) brief.trackingAvailable = false
  return brief
}

/**
 * Cross-project question: which projects deserve a brief?
 * docsFocus: projects with ANY open installment missing documents first (missingIds = project ids
 * found from the installments; without it the overview's "next installment" is the only signal),
 * then red, amber, green.
 * @param {object[]} rows project_tracking_overview rows
 * @returns {object[]} up to `limit` rows
 */
export function selectBriefRows(rows, { limit = GROUNDING_LIMITS.BRIEFS, docsFocus = false, missingIds = null } = {}) {
  const missing = (row) =>
    hasInstallments(row) && (missingIds ? missingIds.has(String(row.project_id)) : row.next_docs_state === 'missing')
  const decorated = (rows || []).map((row) => ({
    row,
    level: computeHealth(row).level,
    docsMissing: missing(row) ? 0 : 1,
  }))
  decorated.sort(
    (a, b) =>
      (docsFocus ? a.docsMissing - b.docsMissing : 0) ||
      HEALTH_ORDER[a.level] - HEALTH_ORDER[b.level] ||
      (hasInstallments(b.row) ? b.row.installments_overdue || 0 : 0) - (hasInstallments(a.row) ? a.row.installments_overdue || 0 : 0) ||
      String(a.row.project_code || '').localeCompare(String(b.row.project_code || ''))
  )
  return decorated.slice(0, limit).map((d) => d.row)
}

// Does the overview row suggest the project has installments worth fetching?
const hasOpenWork = (row) =>
  hasInstallments(row) && (row.installments_total || 0) > 0 && (!!row.next_installment_id || (row.installments_overdue || 0) > 0 || (row.installments_returned || 0) > 0)

// ---------- 6. orchestration ----------
/**
 * Decide, from the query alone, whether (and about what) to ground.
 * @param {{prevProjectIds?: string[]}} [opts] projects the previous bot answer was about
 * @returns {{wants:boolean, projects:object[], inherited:boolean, allProjects:boolean, trackingOnly:boolean, needsContent:boolean, docsFocus:boolean, needsProject:boolean, permitActive:boolean}}
 */
export function planGrounding(query, history, projects, { prevProjectIds = [] } = {}) {
  const det = detectProjects(query, projects)
  let wants = wantsGrounding(query, det)
  const permitActive = isPermitConversation(history)
  let projs = det.projects
  let inherited = false
  if (wants && !projs.length && !det.allProjects) {
    if (permitActive) wants = false // the permit checklist flow owns this conversation: never carry a project over
    else {
      projs = detectProjectsFromHistory(history, projects, prevProjectIds)
      inherited = projs.length > 0
    }
  }
  const trackingOnly = isTrackingOnly(query)
  const allProjects = det.allProjects && projs.length === 0
  const typeAsked = TYPE_INTENTS.some((t) => t.re.test(norm(query)))
  // "สถานะโครงการเป็นอย่างไร" with no project anywhere: ask which one instead of guessing.
  const needsProject = wants && !projs.length && !allProjects && (trackingOnly || (SUMMARY_RE.test(norm(query)) && !typeAsked))
  return {
    wants,
    projects: projs,
    inherited,
    allProjects,
    trackingOnly,
    needsContent: wants && !trackingOnly,
    docsFocus: /เอกสาร|เช็กลิสต์|เช็คลิสต์|checklist|document/i.test(query || ''),
    needsProject,
    permitActive,
  }
}

const safe = async (fn, ms = 8000) => {
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(() => r(null), ms))])
  } catch {
    return null
  }
}

const MAX_PORTFOLIO_INSTALLMENT_READS = 30

/**
 * Build the `grounding` request field (null when there is nothing useful to attach).
 * @param {ReturnType<typeof planGrounding>} plan
 * @param {string} query
 * @param {{projects:object[], files:object[]}} ctx   (files WITH contentText)
 * @param {{getOverview:()=>Promise<{data:object[]|null}>, getInstallments:(projectId:string)=>Promise<{data:object[]|null}>, contentState?: 'ready'|'pending'|'partial'}} deps
 *   contentState: when not 'ready', files without text are "not loaded yet" (notLoaded), NOT "not indexed".
 *   now: clock for date plausibility when parsing meeting dates (tests).
 * @returns {Promise<{grounding: object|null, stats: object, notIndexed: object[], notLoaded: object[], truncated: object[], briefs: object[], trackingFailed: boolean, projectsTotal: number|null, projectsShown: number|null, coverage: object|null}>}
 */
export async function buildGrounding(plan, query, ctx, deps = {}) {
  const projects = ctx?.projects || []
  const files = ctx?.files || []
  const empty = {
    grounding: null, stats: { briefs: 0, passages: 0, chars: 0 }, notIndexed: [], notLoaded: [], truncated: [],
    briefs: [], trackingFailed: false, projectsTotal: null, projectsShown: null, coverage: null, meetings: [],
  }
  if (!plan?.wants) return empty
  const contentState = deps.contentState || 'ready'

  // --- briefs ---
  let briefs = []
  let trackingFailed = false
  let projectsTotal = null
  let projectsShown = null
  let docsScan = null
  const wantBriefs = plan.projects.length > 0 || plan.allProjects
  const overview = wantBriefs && deps.getOverview ? await safe(deps.getOverview) : null
  const rows = Array.isArray(overview?.data) ? overview.data : null
  if (wantBriefs && !rows) trackingFailed = true
  // { ok, data }: ok=false means the read failed (never "no installments")
  const fetchInst = async (id) => {
    if (!deps.getInstallments) return { ok: true, data: [] }
    const r = await safe(() => deps.getInstallments(id))
    return Array.isArray(r?.data) ? { ok: true, data: r.data } : { ok: false, data: [] }
  }
  if (plan.projects.length) {
    briefs = await Promise.all(
      plan.projects.map(async (p) => {
        const row = rows?.find((r) => String(r.project_id) === String(p.id)) || null
        // a project set to "no billing installments" needs no installment read at all
        const res = !row ? { ok: false, data: [] } : hasInstallments(row) ? await fetchInst(p.id) : { ok: true, data: [] }
        return buildProjectBrief(p, row, res.data, { installmentsFailed: !res.ok })
      })
    )
  } else if (plan.allProjects && rows) {
    projectsTotal = rows.length
    const instById = new Map()
    let missingIds = null
    if (plan.docsFocus) {
      // documents question: look at EVERY project's installments (bounded), not just the next one
      // projects switched to "no billing installments" are counted on their own (projectsNoBilling),
      // never read and never reported as "no installment data" / "could not check"
      const billable = (r) => hasInstallments(r) && (r.installments_total || 0) > 0
      const readable = rows.filter(billable).slice(0, MAX_PORTFOLIO_INSTALLMENT_READS)
      await Promise.all(readable.map(async (r) => instById.set(String(r.project_id), await fetchInst(r.project_id))))
      missingIds = new Set()
      // A deterministic answer to "which projects miss billing documents", computed from the raw
      // installments of EVERY readable project (not from the capped briefs below). The model is
      // told to state this first, instead of inferring it from many briefs.
      let installmentsMissing = 0
      let projectsUnreadable = 0
      const missingProjects = []
      for (const [id, res] of instById) {
        if (!res.ok) { projectsUnreadable++; continue }
        const n = res.data.filter(hasMissingDocsRaw).length
        if (n > 0) {
          missingIds.add(id)
          installmentsMissing += n
          const row = rows.find((r) => String(r.project_id) === id)
          missingProjects.push(String(row?.project_code || row?.project_name || id).slice(0, 50))
        }
      }
      const withInstallments = rows.filter(billable).length
      const projectsNoBilling = rows.filter((r) => !hasInstallments(r)).length
      docsScan = {
        projectsTotal: rows.length,
        projectsChecked: instById.size - projectsUnreadable,
        projectsWithoutInstallments: rows.length - withInstallments - projectsNoBilling,
        projectsUnreadable,
        projectsNotRead: Math.max(0, withInstallments - readable.length),
        projectsWithMissing: missingIds.size,
        installmentsMissing,
        missingProjects: missingProjects.slice(0, GROUNDING_LIMITS.PORTFOLIO_BRIEFS),
      }
      // only when some project is set to "no billing installments": otherwise the request stays exactly as before
      if (projectsNoBilling > 0) docsScan.projectsNoBilling = projectsNoBilling
    }
    const picked = selectBriefRows(rows, { limit: GROUNDING_LIMITS.PORTFOLIO_BRIEFS, docsFocus: plan.docsFocus, missingIds })
    briefs = await Promise.all(
      picked.map(async (row) => {
        const id = String(row.project_id)
        const p = projects.find((x) => String(x.id) === id) || { id: row.project_id, code: row.project_code, name: row.project_name }
        const res = instById.get(id) || (hasOpenWork(row) ? await fetchInst(row.project_id) : { ok: true, data: [] })
        return buildProjectBrief(p, row, res.data, { onlyAttention: true, installmentsFailed: !res.ok })
      })
    )
  }
  briefs = briefs.slice(0, plan.projects.length ? GROUNDING_LIMITS.BRIEFS : GROUNDING_LIMITS.PORTFOLIO_BRIEFS)
  if (projectsTotal !== null) projectsShown = briefs.length

  // --- passages ---
  let selected = []
  let passages = []
  let meetings = []
  const now = deps.now instanceof Date ? deps.now : new Date()
  if (!plan.trackingOnly) {
    const exclude = plan.projects.flatMap((p) => [p.code, p.name]).filter(Boolean)
    selected = selectDocuments(query, plan.projects.map((p) => p.id), files, { exclude, now })
    const scopeIds = new Set(plan.projects.map((p) => String(p.id)))
    const scopeFiles = files.filter((f) => f && (scopeIds.size === 0 || scopeIds.has(String(f.projectId))))
    passages = buildPassages(selected, query, { projects, exclude, now, scopeFiles })
    meetings = buildMeetingsInfo(scopeFiles, selected, passages, projects, now)
  }
  const flags = flagUnreadable(selected)
  let notIndexed = flags.notIndexed
  let notLoaded = []
  if (contentState !== 'ready') {
    // text may simply not have arrived yet: do not claim the file is unreadable
    notLoaded = notIndexed
    notIndexed = []
  }
  const truncated = flags.truncated

  let coverage = null
  if (!plan.trackingOnly) {
    const sentBy = new Map()
    for (const p of passages) sentBy.set(String(p.fileId), (sentBy.get(String(p.fileId)) || 0) + p.text.length)
    const fullyRead = (f) => (sentBy.get(String(f.id)) || 0) >= String(f.contentText || '').trim().length * 0.98
    coverage = {
      filesRead: sentBy.size,
      filesSelected: selected.length,
      partial: notLoaded.length > 0 || contentState !== 'ready' || selected.some((f) => !fullyRead(f)),
    }
  }

  const base = { ...empty, notIndexed, notLoaded, truncated, trackingFailed, projectsTotal, projectsShown, coverage, meetings }
  if (!briefs.length && !passages.length) return base

  const grounding = { projectBriefs: briefs, passages, notIndexed, truncated }
  if (projectsTotal !== null) {
    grounding.projectsTotal = projectsTotal
    grounding.projectsShown = projectsShown
  }
  if (coverage) grounding.passageCoverage = coverage
  if (docsScan) grounding.docsScan = docsScan
  if (meetings.length) grounding.meetings = meetings
  return {
    ...base,
    grounding,
    stats: { briefs: briefs.length, passages: passages.length, chars: passages.reduce((n, p) => n + p.text.length, 0) },
    briefs,
  }
}

// ---------- 7. deterministic answers when the AI is unavailable ----------
const HEALTH_TH = { red: 'ต้องดำเนินการ', amber: 'ควรติดตาม', green: 'ปกติ' }
export const TRACKING_FAILED_TEXT = 'โหลดข้อมูลเบิกงวดงานไม่สำเร็จ ลองใหม่อีกครั้ง'
export const NO_BILLING_BRIEF_TEXT = 'งวดงาน: โครงการนี้ไม่มีงวดเบิก (ตั้งค่าไว้)'
export const NO_BILLING_SCAN_TEXT = 'โครงการไม่มีงวดเบิก (ตั้งค่าไว้)'
export const portfolioCapNote = (shown, total) =>
  Number.isFinite(total) && Number.isFinite(shown) && shown < total ? `แสดง ${shown} จาก ${total} โครงการ` : ''

/** Real project examples from the library for "โปรดระบุชื่อหรือรหัสโครงการ". */
export function needProjectMessage(projects, files = []) {
  const count = new Map()
  for (const f of files) count.set(String(f.projectId), (count.get(String(f.projectId)) || 0) + 1)
  const ex = [...(projects || [])]
    .filter((p) => p && (p.code || p.name))
    .sort((a, b) => (count.get(String(b.id)) || 0) - (count.get(String(a.id)) || 0))
    .slice(0, 2)
    .map((p) => `"${p.code || p.name}"`)
  return `โปรดระบุชื่อหรือรหัสโครงการที่ต้องการให้สรุป${ex.length ? ` เช่น ${ex.join(' หรือ ')}` : ''} (หรือถามภาพรวมว่า "โครงการไหน…")`
}

/**
 * Plain-language status from the briefs alone (no AI). Returns null when the question is not a
 * tracking question or there is nothing to say. Briefs with trackingAvailable:false never produce data claims.
 * @param {{projectsTotal?: number|null, projectsShown?: number|null}} [info]
 */
export function localTrackingAnswer(query, briefs, info = {}) {
  if (!isTrackingOnly(query) || !Array.isArray(briefs) || !briefs.length) return null
  const ok = briefs.filter((b) => b.trackingAvailable !== false)
  if (!ok.length) return TRACKING_FAILED_TEXT
  const q = norm(query)
  const docsQ = /เอกสาร|ขาด/.test(q)
  const lines = []
  const list = docsQ ? ok.filter((b) => !b.noInstallments && b.installments.some(hasMissingDocsBrief)) : ok
  const failed = briefs.filter((b) => b.trackingAvailable === false)
  const cap = portfolioCapNote(info.projectsShown, info.projectsTotal)
  const checkedSome = ok.some((b) => !b.noInstallments) || (info.docsScan?.projectsChecked || 0) > 0
  if (docsQ && !list.length && checkedSome) lines.push('ไม่พบงวดที่เอกสารเบิกยังขาดในโครงการที่โหลดข้อมูลได้ (ตามข้อมูลเบิกงวดงานในระบบ)')
  // documents question: projects set to "no billing installments" get their own line (after the answer
  // itself), never "no installment data" / "could not check"
  let noBillingLine = ''
  if (docsQ) {
    const noBillingBriefs = ok.filter((b) => b.noInstallments)
    const scanned = Number.isFinite(info.docsScan?.projectsNoBilling) ? info.docsScan.projectsNoBilling : null
    const n = scanned !== null ? Math.max(scanned, noBillingBriefs.length) : noBillingBriefs.length
    if (n > 0) {
      const codes = scanned === null ? noBillingBriefs.map((b) => b.code || b.name).filter(Boolean) : []
      noBillingLine = `${n} ${NO_BILLING_SCAN_TEXT}${codes.length ? `: ${codes.join(', ')}` : ''}`
    }
  }
  for (const b of list) {
    lines.push(`**${b.code || ''} ${b.name || ''}**`.trim())
    if (b.progress) {
      const pr = b.progress
      const pct = pr.percent == null ? 'ยังไม่เคยอัปเดต % ความคืบหน้า' : `ความคืบหน้า ${pr.percent}%${pr.asOf ? ` (ณ ${fmtThaiDate(pr.asOf)})` : ''}`
      lines.push(`${pct}${pr.timeElapsedPct != null ? ` · เวลาตามสัญญาผ่านไป ${pr.timeElapsedPct}%` : ''} · สถานะ: ${HEALTH_TH[pr.health] || '-'}`)
      for (const r of pr.reasons) lines.push(`• ${r}`)
    }
    if (b.noInstallments) lines.push(`• ${NO_BILLING_BRIEF_TEXT}`)
    for (const i of b.installments) {
      if (docsQ && !hasMissingDocsBrief(i)) continue
      if (!docsQ && !OPEN_STATUSES.includes(i.status) && !hasMissingDocsBrief(i)) continue
      const docs = hasMissingDocsBrief(i) ? ` · เอกสารขาด ${Math.max(0, i.docs.total - i.docs.attached)} รายการ` : ''
      lines.push(`• งวดที่ ${i.no} ${i.statusLabel}${i.plannedBillDate ? ` · กำหนดเบิก ${fmtThaiDate(i.plannedBillDate)}` : ''}${docs}`)
    }
    lines.push('')
  }
  if (noBillingLine) lines.push(noBillingLine)
  for (const b of failed) lines.push(`${`**${b.code || ''} ${b.name || ''}**`.trim()} — ${TRACKING_FAILED_TEXT}`)
  if (cap) lines.push(cap)
  return lines.join('\n').trim() || null
}

/**
 * Local (no AI) answer for a grounded question, or null to fall through to file search.
 * needsProject -> asks which project; tracking questions -> deterministic answer / honest failure.
 */
export function localAnswer(query, plan, built, ctx) {
  if (!plan?.wants) return null
  if (plan.needsProject) return needProjectMessage(ctx?.projects, ctx?.files)
  if (!plan.trackingOnly) return null
  if (built?.trackingFailed) return TRACKING_FAILED_TEXT
  return localTrackingAnswer(query, built?.briefs || [], {
    projectsTotal: built?.projectsTotal,
    projectsShown: built?.projectsShown,
    docsScan: built?.grounding?.docsScan || null,
  })
}

/** [1,2,3,5] -> "1–3, 5" */
export function rangeText(nums) {
  const a = [...new Set((nums || []).filter((n) => Number.isInteger(n)))].sort((x, y) => x - y)
  const out = []
  for (let i = 0; i < a.length; ) {
    let j = i
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++
    out.push(j > i ? (j === i + 1 ? `${a[i]}, ${a[j]}` : `${a[i]}–${a[j]}`) : String(a[i]))
    i = j + 1
  }
  return out.join(', ')
}

/**
 * Plain list of the meeting series for the local (no AI) path: per series, the meetings read and the ones that
 * exist but were not (number order / year-number order / date order as the series is ordered, never upload order
 * unless flagged). Null when there are no meetings.
 * NOT wired into localAnswer(): that returns text only and would drop the file cards of the search fallback.
 * AIChat can append this text to the search-fallback reply: localMeetingsAnswer(built.meetings).
 * @param {ReturnType<typeof buildMeetingsInfo>} meetings
 */
export function localMeetingsAnswer(meetings) {
  if (!Array.isArray(meetings) || !meetings.length) return null
  const label = (x) => (x.no != null ? `ครั้งที่ ${x.no}${x.year ? '/' + x.year : ''}` : x.fileName || 'ไฟล์ไม่มีหมายเลขครั้ง')
  const lines = ['รายงานการประชุมที่พบ (เรียงตามชุด หมายเลขครั้ง และวันที่ประชุม ไม่ใช่วันที่อัปโหลด):']
  for (const m of meetings) {
    const read = [...m.used, ...m.unread]
    const parts = []
    if (m.ordering === 'number') {
      const nos = read.filter((x) => x.no != null).map((x) => x.no)
      const named = read.filter((x) => x.no == null).map((x) => x.fileName).filter(Boolean)
      if (nos.length) parts.push(`ครั้งที่ ${rangeText(nos)}`)
      if (named.length) parts.push(named.join(', '))
      if (m.notUsed.length) parts.push(`ไม่ได้ใช้ครั้งที่ ${rangeText(m.notUsed)}`)
    } else {
      if (read.length) parts.push(read.map(label).join(', '))
      if (m.notUsedItems?.length) parts.push(`ไม่ได้ใช้ ${m.notUsedItems.map(label).join(', ')}${m.notUsedTotal > m.notUsedItems.length ? ' …' : ''}`)
    }
    lines.push(`• ${m.series}${m.projectCode ? ` (${m.projectCode})` : ''}: ${parts.join('; ') || '-'}`)
    if (m.orderedByUpload) lines.push('  ⚠ ลำดับของชุดนี้อิงวันที่อัปโหลดไฟล์ (ชื่อไฟล์ไม่มีหมายเลขครั้ง/วันที่ประชุมครบ) จึงอาจไม่ตรงกับลำดับการประชุมจริง')
  }
  return lines.join(NL)
}

// Passage markers ([P1], [P12], 【P3】) are for the model's grounding only: never show them.
export const stripPassageMarkers = (text) => String(text ?? '').replace(/\s*[\[【]P\d{1,3}[\]】]/g, '')
