// Chat retrieval + grounding builder (pure functions: no React / Supabase imports, so
// everything here can be unit-tested in plain node).
//
// The chat server (api/chat.js) answers summary / content / status questions ONLY from
// the `grounding` object built here:
//   { projectBriefs, passages, notIndexed, truncated, [projectsTotal, projectsShown], [passageCoverage] }
// Policy this module enforces:
//   * PRIVACY: phone numbers and Thai national-ID numbers are scrubbed from passage text and
//     from every free-text brief field ("[เบอร์โทร]" / "[เลขบัตร]"). Briefs are built field by
//     field from an allow-list: no phone column, no recorder / user names.
//   * MONEY: the tracking data has no money fields and none are added. Amounts that appear
//     INSIDE a document passage (contract text, minutes) are sent as written - they are the
//     document's own content and are not scrubbed.
//   * bounded size (<= 6 briefs, <= 14 passages, <= ~40k passage chars, each <= 4000),
//   * the context files are never mutated.

import { computeHealth, HEALTH_ORDER, STATUS_LABEL, OPEN_STATUSES, splitCoNames, fmtThaiDate } from './tracking.js'

export const GROUNDING_LIMITS = {
  BRIEFS: 6,
  PASSAGES: 14,
  PASSAGE_CHARS: 4000,
  TOTAL_PASSAGE_CHARS: 40000,
  FILES: 8,
  INSTALLMENTS: 40,
  NOTE_CHARS: 300,
  STORED_TEXT_CAP: 50000, // content_text is cut at this length at storage time
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

const fileCmp = (a, b) => {
  const d = String(b.date || '').localeCompare(String(a.date || ''))
  return d || String(b.name || '').localeCompare(String(a.name || ''))
}

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
 *  - document-type intent: ประชุม/MOM -> newest 3 'mom'; สัญญา -> latest 'contract'; TOR/ขอบเขต -> 'tor'; EIA -> 'eia'
 *  - "สรุปโครงการ" (no explicit type) -> newest 3 'mom' + latest 'contract' + 'tor' if present
 *  - plus files whose name / extracted text contain the query terms
 * @param {string} query
 * @param {string[]} projectIds restrict to these projects (empty = whole library)
 * @param {object[]} files context files (normalizeFile objects); never mutated
 * @param {{exclude?: string[], max?: number}} [opts] exclude = project codes/names to ignore as keywords
 */
export function selectDocuments(query, projectIds, files, { exclude = [], max = GROUNDING_LIMITS.FILES } = {}) {
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
      // every MOM is its own meeting, and isLatest is per base name (dates are stripped from
      // base names), so meetings are ranked by date, not by isLatest.
      list = [...list].sort(fileCmp)
    }
    list.slice(0, limit).forEach((f, i) => take(f, prio - i))
  }

  if (explicit.length) {
    perProject((group) => explicit.forEach((t) => pickType(group, t.type, t.limit, t.byDate, 100)))
  } else if (summary) {
    perProject((group) => {
      pickType(group, 'mom', 3, true, 90)
      pickType(group, 'contract', 1, false, 89)
      pickType(group, 'tor', 1, false, 88)
    })
  }

  // keyword-scored files
  const terms = queryTerms(q, { exclude })
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

/**
 * Best 1-3 chunks of one file for this query. Pure: `file` is not modified.
 * @param {object} file
 * @param {string} query
 * @param {{maxChars?:number, perFile?:number, chunkSize?:number, positional?:boolean, terms?:{term:string,weight:number}[], projectCode?:string}} [opts]
 *   positional: prefer the beginning (agenda / attendees / decisions) - MOM and summary questions
 * @returns {{fileId,fileName,projectCode,type,date,text:string,score:number,start:number}[]} in document order
 */
export function extractPassages(file, query, opts = {}) {
  const maxChars = Math.min(opts.maxChars || GROUNDING_LIMITS.PASSAGE_CHARS, GROUNDING_LIMITS.PASSAGE_CHARS)
  const perFile = Math.max(1, Math.min(opts.perFile || 2, 3))
  const raw = cleanText(file?.contentText)
  if (!raw.trim()) return []
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
  return keep.map((c) => ({
    fileId: file.id,
    fileName: file.name,
    projectCode: opts.projectCode || '',
    type: file.type || 'other',
    date: file.date || '',
    text: scrubText(c.text).slice(0, maxChars),
    score: c.score,
    start: c.start,
  }))
}

/**
 * Passages for several files within the overall budget, with pids P1..Pn.
 * Breadth first: every file gets its best chunk before any file gets a second one.
 * Output order = file order (the priority order from selectDocuments), then position in the file.
 * @returns {{pid,fileId,fileName,projectCode,type,date,text}[]}
 */
export function buildPassages(files, query, opts = {}) {
  const {
    projects = [],
    maxPassages = GROUNDING_LIMITS.PASSAGES,
    maxTotalChars = GROUNDING_LIMITS.TOTAL_PASSAGE_CHARS,
    maxChars = GROUNDING_LIMITS.PASSAGE_CHARS,
    exclude = [],
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
      if (text.length > room) text = text.slice(0, room)
      total += text.length
      picked.push({ fi, c: { ...c, text } })
    }
  }
  picked.sort((a, b) => a.fi - b.fi || a.c.start - b.c.start)
  return picked.map(({ c }, i) => ({
    pid: `P${i + 1}`,
    fileId: c.fileId,
    fileName: c.fileName,
    projectCode: c.projectCode,
    type: c.type,
    date: c.date,
    text: c.text,
  }))
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

  let inst = Array.isArray(installments) ? [...installments] : []
  inst.sort((a, b) => (a.installment_no || 0) - (b.installment_no || 0))
  if (onlyAttention) inst = inst.filter(needsAttention)

  const brief = {
    projectId: p.id ?? row?.project_id ?? null,
    code: p.code ?? row?.project_code ?? null,
    name: p.name ?? row?.project_name ?? null,
    status: row?.project_status ?? p.status ?? null,
    projectCo: names.length ? names.join(', ') : null,
    contract: start || end ? { start, end } : null,
    progress,
    installments: inst.slice(0, GROUNDING_LIMITS.INSTALLMENTS).map(briefInstallment),
  }
  if (!row || installmentsFailed) brief.trackingAvailable = false
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
  const missing = (row) => (missingIds ? missingIds.has(String(row.project_id)) : row.next_docs_state === 'missing')
  const decorated = (rows || []).map((row) => ({
    row,
    level: computeHealth(row).level,
    docsMissing: missing(row) ? 0 : 1,
  }))
  decorated.sort(
    (a, b) =>
      (docsFocus ? a.docsMissing - b.docsMissing : 0) ||
      HEALTH_ORDER[a.level] - HEALTH_ORDER[b.level] ||
      (b.row.installments_overdue || 0) - (a.row.installments_overdue || 0) ||
      String(a.row.project_code || '').localeCompare(String(b.row.project_code || ''))
  )
  return decorated.slice(0, limit).map((d) => d.row)
}

// Does the overview row suggest the project has installments worth fetching?
const hasOpenWork = (row) =>
  (row.installments_total || 0) > 0 && (!!row.next_installment_id || (row.installments_overdue || 0) > 0 || (row.installments_returned || 0) > 0)

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
 * @returns {Promise<{grounding: object|null, stats: object, notIndexed: object[], notLoaded: object[], truncated: object[], briefs: object[], trackingFailed: boolean, projectsTotal: number|null, projectsShown: number|null, coverage: object|null}>}
 */
export async function buildGrounding(plan, query, ctx, deps = {}) {
  const projects = ctx?.projects || []
  const files = ctx?.files || []
  const empty = {
    grounding: null, stats: { briefs: 0, passages: 0, chars: 0 }, notIndexed: [], notLoaded: [], truncated: [],
    briefs: [], trackingFailed: false, projectsTotal: null, projectsShown: null, coverage: null,
  }
  if (!plan?.wants) return empty
  const contentState = deps.contentState || 'ready'

  // --- briefs ---
  let briefs = []
  let trackingFailed = false
  let projectsTotal = null
  let projectsShown = null
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
        const res = row ? await fetchInst(p.id) : { ok: false, data: [] }
        return buildProjectBrief(p, row, res.data, { installmentsFailed: !res.ok })
      })
    )
  } else if (plan.allProjects && rows) {
    projectsTotal = rows.length
    const instById = new Map()
    let missingIds = null
    if (plan.docsFocus) {
      // documents question: look at EVERY project's installments (bounded), not just the next one
      const readable = rows.filter((r) => (r.installments_total || 0) > 0).slice(0, MAX_PORTFOLIO_INSTALLMENT_READS)
      await Promise.all(readable.map(async (r) => instById.set(String(r.project_id), await fetchInst(r.project_id))))
      missingIds = new Set()
      for (const [id, res] of instById) if (res.ok && res.data.some(hasMissingDocsRaw)) missingIds.add(id)
    }
    const picked = selectBriefRows(rows, { docsFocus: plan.docsFocus, missingIds })
    briefs = await Promise.all(
      picked.map(async (row) => {
        const id = String(row.project_id)
        const p = projects.find((x) => String(x.id) === id) || { id: row.project_id, code: row.project_code, name: row.project_name }
        const res = instById.get(id) || (hasOpenWork(row) ? await fetchInst(row.project_id) : { ok: true, data: [] })
        return buildProjectBrief(p, row, res.data, { onlyAttention: true, installmentsFailed: !res.ok })
      })
    )
  }
  briefs = briefs.slice(0, GROUNDING_LIMITS.BRIEFS)
  if (projectsTotal !== null) projectsShown = briefs.length

  // --- passages ---
  let selected = []
  let passages = []
  if (!plan.trackingOnly) {
    const exclude = plan.projects.flatMap((p) => [p.code, p.name]).filter(Boolean)
    selected = selectDocuments(query, plan.projects.map((p) => p.id), files, { exclude })
    passages = buildPassages(selected, query, { projects, exclude })
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

  const base = { ...empty, notIndexed, notLoaded, truncated, trackingFailed, projectsTotal, projectsShown, coverage }
  if (!briefs.length && !passages.length) return base

  const grounding = { projectBriefs: briefs, passages, notIndexed, truncated }
  if (projectsTotal !== null) {
    grounding.projectsTotal = projectsTotal
    grounding.projectsShown = projectsShown
  }
  if (coverage) grounding.passageCoverage = coverage
  return {
    ...base,
    grounding,
    stats: { briefs: briefs.length, passages: passages.length, chars: passages.reduce((n, p) => n + p.text.length, 0) },
    briefs,
  }
}

// ---------- 7. deterministic answers when the AI is unavailable ----------
const HEALTH_TH = { red: 'ต้องดำเนินการ', amber: 'ควรติดตาม', green: 'ปกติ' }
export const TRACKING_FAILED_TEXT = 'โหลดข้อมูลติดตามงานไม่สำเร็จ ลองใหม่อีกครั้ง'
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
  const list = docsQ ? ok.filter((b) => b.installments.some(hasMissingDocsBrief)) : ok
  const failed = briefs.filter((b) => b.trackingAvailable === false)
  const cap = portfolioCapNote(info.projectsShown, info.projectsTotal)
  if (docsQ && !list.length) lines.push('ไม่พบงวดที่เอกสารเบิกยังขาดในโครงการที่โหลดข้อมูลได้ (ตามข้อมูลติดตามงานในระบบ)')
  for (const b of list) {
    lines.push(`**${b.code || ''} ${b.name || ''}**`.trim())
    if (b.progress) {
      const pr = b.progress
      const pct = pr.percent == null ? 'ยังไม่เคยอัปเดต % ความคืบหน้า' : `ความคืบหน้า ${pr.percent}%${pr.asOf ? ` (ณ ${fmtThaiDate(pr.asOf)})` : ''}`
      lines.push(`${pct}${pr.timeElapsedPct != null ? ` · เวลาตามสัญญาผ่านไป ${pr.timeElapsedPct}%` : ''} · สถานะ: ${HEALTH_TH[pr.health] || '-'}`)
      for (const r of pr.reasons) lines.push(`• ${r}`)
    }
    for (const i of b.installments) {
      if (docsQ && !hasMissingDocsBrief(i)) continue
      if (!docsQ && !OPEN_STATUSES.includes(i.status) && !hasMissingDocsBrief(i)) continue
      const docs = hasMissingDocsBrief(i) ? ` · เอกสารขาด ${Math.max(0, i.docs.total - i.docs.attached)} รายการ` : ''
      lines.push(`• งวดที่ ${i.no} ${i.statusLabel}${i.plannedBillDate ? ` · กำหนดเบิก ${fmtThaiDate(i.plannedBillDate)}` : ''}${docs}`)
    }
    lines.push('')
  }
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
  return localTrackingAnswer(query, built?.briefs || [], { projectsTotal: built?.projectsTotal, projectsShown: built?.projectsShown })
}

// Passage markers ([P1], [P12], 【P3】) are for the model's grounding only: never show them.
export const stripPassageMarkers = (text) => String(text ?? '').replace(/\s*[\[【]P\d{1,3}[\]】]/g, '')
