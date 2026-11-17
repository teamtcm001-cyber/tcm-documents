// Bulk onboarding from an Excel file ("นำเข้าจากไฟล์ Excel", admin console).
// PURE planning logic: no Supabase, no DOM, no network, so it runs in plain node (unit tests).
//   readWorkbook(buffer)                    -> { projectRows, peopleRows, peopleCells, sheets }   (lazy-loads `xlsx`)
//   parseImport({projectRows,peopleRows,peopleCells}) -> { people, projects, warnings }
//   prepareProjectIndex(systemProjects)     -> index (build once per snapshot)
//   autoMapProjects(parsed.projects, systemProjects|index) -> per row { projectId (EXACT only), suggestion, ... }
//   makePersonIndex(parsed.people)          -> { match(coName) } (memoised; build once per file)
//   buildPlan({ parsed, users, projects, memberships, mapping, ... }) -> plan
// Employee ids (column "ID") are secrets: kept on the parsed person as a NON-ENUMERABLE property (never rendered,
// never in JSON.stringify / console dumps) and read only through getInitialPassword().

export const ADMIN_CO = 'admin'
export const MAX_PASSWORD_BYTES = 72 // bcrypt limit; mirrors api/admin-users.js
export const LIMITS = { maxRows: 3000, maxCols: 50, maxItems: 1000 }

// ---------------------------------------------------------------------------
// small text helpers
// ---------------------------------------------------------------------------
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const FORMULA_LEAD = /^[=+\-@]/ // spreadsheet-formula injection characters

const cellText = (v) => (v === null || v === undefined ? '' : String(v)).replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()
const isEmptyCell = (v) => cellText(v) === ''

// "-" and friends mean "nobody"
const NONE_VALUES = new Set(['-', '–', '—', '--', 'n/a', 'na', 'none', 'null', 'ไม่มี', 'ไม่ระบุ'])
export const isNoneCell = (v) => {
  const t = cellText(v).toLowerCase()
  return t === '' || NONE_VALUES.has(t)
}

// Mirrors api/admin-users.js vEmail (ASCII only).
export function isValidEmail(e) {
  const at = e.lastIndexOf('@')
  return !(
    e.length > 254 ||
    at < 1 ||
    at > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e) ||
    e.includes('..') ||
    e.startsWith('.') ||
    e.slice(0, at).endsWith('.')
  )
}

// trim + strip zero-width characters only. whitespace INSIDE the address is NOT removed (tokens are never merged):
// -> { email, problem: null | 'empty' | 'space' | 'lead' | 'invalid' }
export function readEmail(raw) {
  const s = String(raw ?? '').replace(ZERO_WIDTH, '').trim().replace(/^mailto:/i, '')
  if (!s) return { email: '', problem: 'empty' }
  if (/\s/.test(s)) return { email: s, problem: 'space' }
  const email = s.toLowerCase()
  if (FORMULA_LEAD.test(email)) return { email, problem: 'lead' }
  if (!isValidEmail(email)) return { email, problem: 'invalid' }
  return { email, problem: null }
}

// Letters (incl. Thai vowels / tone marks: \p{M}) and digits only, lower-case, single spaces.
export function normKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}
const compact = (k) => k.replace(/ /g, '')

export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}
export const similarity = (a, b) => {
  const m = Math.max(a.length, b.length)
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m
}

// ---------------------------------------------------------------------------
// secrets: the employee id never leaves memory and never shows up in dumps
// ---------------------------------------------------------------------------
// idStatus: 'missing' | 'ok' (text) | 'numeric' (integer cell) | 'unusable' (date / float / scientific / unsafe)
function makePerson({ rowNo, name, email, role, employeeId, idStatus }) {
  const usable = idStatus === 'ok' || idStatus === 'numeric'
  const p = { rowNo, name, email, role, idStatus, hasId: usable }
  Object.defineProperty(p, 'employeeId', { value: usable ? employeeId : '', enumerable: false, writable: false })
  return p
}

// Why this id cannot be used as the first password (null = usable).
export function idProblem(id) {
  const v = typeof id === 'string' ? id.trim() : ''
  if (!v) return 'missing'
  if (/\p{Cc}/u.test(v)) return 'invalid'
  if (new TextEncoder().encode(v).length > MAX_PASSWORD_BYTES) return 'too_long'
  return null
}
// The first password to send for this person, or null when the id is missing / unusable (random password then).
export function getInitialPassword(person) {
  if (!person || !(person.idStatus === 'ok' || person.idStatus === 'numeric')) return null
  const v = typeof person.employeeId === 'string' ? person.employeeId.trim() : ''
  return idProblem(v) ? null : v
}
// length of the usable id (for the "shorter than 6" warning) without exposing the value
const idLength = (person) => (getInitialPassword(person) || '').length

// Typed read of one ID cell. cell = { t, v, w } (SheetJS) | undefined (plain rows: treated as text).
// How Excel DISPLAYS a long number it cannot show in full (always with a sign: 1.5E+13). Text that
// already looks like that was corrupted before it reached us -> unusable. A real text ID such as
// '15E0590' (digits-E-digits, NO sign) is valid.
const SCI_DISPLAY = /^\d+([.,]\d+)?E[+-]\d+$/i
function readId(text, cell) {
  const t = cellText(text)
  if (!t && (!cell || cell.v === undefined || cell.v === null || cell.v === '')) return { status: 'missing', value: '' }
  if (cell && cell.f) return { status: 'unusable', value: '' } // a formula result is not an employee id
  if (!cell || cell.t === 's') {
    if (SCI_DISPLAY.test(t) || idProblem(t)) return { status: 'unusable', value: '' }
    return { status: 'ok', value: t }
  }
  if (cell.t === 'n') {
    const w = cellText(cell.w ?? cell.v)
    // a pure-digit integer cell; anything formatted as a date / float / scientific is not trustworthy
    if (Number.isInteger(cell.v) && cell.v >= 0 && /^\d{1,12}$/.test(w)) return { status: 'numeric', value: w }
    return { status: 'unusable', value: '' }
  }
  return { status: 'unusable', value: '' } // dates, booleans, errors
}

// ---------------------------------------------------------------------------
// reading the workbook (browser or node)
// ---------------------------------------------------------------------------
const looksLikePeopleSheet = (rows) => rows.slice(0, 40).some((r) => r.some((c) => /@/.test(String(c ?? ''))))

// Only the cells that EXIST are visited, and the declared range is checked first: a sheet that merely DECLARES
// A1:XFD1048576 is refused before anything is materialised.
function matrixOf(ws, utils, name) {
  const ref = ws['!fullref'] || ws['!ref']
  if (!ref) return { rows: [], cells: [] }
  const rg = utils.decode_range(ref)
  const nr = rg.e.r - rg.s.r + 1
  const nc = rg.e.c - rg.s.c + 1
  if (nr > LIMITS.maxRows || nc > LIMITS.maxCols) {
    throw new Error(
      `ชีต "${name}" ใหญ่เกินไป (${nr.toLocaleString('en-US')} แถว × ${nc} คอลัมน์) — รับได้สูงสุด ${LIMITS.maxRows} แถว × ${LIMITS.maxCols} คอลัมน์ ลบแถว/คอลัมน์ว่างที่เหลืออยู่ในไฟล์แล้วลองใหม่`
    )
  }
  const rows = Array.from({ length: nr }, () => Array(nc).fill(''))
  const cells = Array.from({ length: nr }, () => Array(nc).fill(undefined))
  for (const addr of Object.keys(ws)) {
    if (addr.charCodeAt(0) === 33 /* ! */) continue
    const cell = ws[addr]
    if (!cell || typeof cell !== 'object') continue
    const a = utils.decode_cell(addr)
    const r = a.r - rg.s.r
    const c = a.c - rg.s.c
    if (r < 0 || c < 0 || r >= nr || c >= nc) continue
    let w = cell.w
    if (w === undefined) {
      try {
        w = utils.format_cell(cell)
      } catch {
        w = cell.v === undefined || cell.v === null ? '' : String(cell.v)
      }
    }
    rows[r][c] = w === undefined || w === null ? '' : String(w)
    cells[r][c] = { t: cell.t, v: cell.v, w: cell.w, f: cell.f }
  }
  return { rows, cells }
}

// buffer: ArrayBuffer | Uint8Array. Returns { projectRows, peopleRows, peopleCells, sheets: { project, people } }.
export async function readWorkbook(buffer) {
  const XLSX = await import('xlsx')
  const read = XLSX.read || (XLSX.default && XLSX.default.read)
  const utils = XLSX.utils || (XLSX.default && XLSX.default.utils)
  let wb
  try {
    // sheetRows: the parser stops after that many rows (the declared dimension is kept in !fullref)
    wb = read(buffer, { type: 'array', cellDates: false, sheetRows: LIMITS.maxRows + 1 })
  } catch {
    throw new Error('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx) ที่ไม่ได้ตั้งรหัสผ่าน')
  }
  const hidden = new Set()
  ;((wb.Workbook && wb.Workbook.Sheets) || []).forEach((s, i) => {
    if (s && s.Hidden) hidden.add(wb.SheetNames[i]) // hidden + veryHidden are ignored
  })
  const names = (wb.SheetNames || []).filter((n) => !hidden.has(n))
  const cache = new Map()
  const get = (n) => {
    if (!cache.has(n)) cache.set(n, matrixOf(wb.Sheets[n], utils, n))
    return cache.get(n)
  }
  const key = (n) => normKey(n)
  // an exact name wins over a loose match
  const pick = (exact, loose) => names.find((n) => key(n) === exact) || names.find(loose)
  let projectName = pick('project list', (n) => /project/.test(key(n)) && /list/.test(key(n)))
  let peopleName = pick('name list', (n) => /name/.test(key(n)) && /list/.test(key(n)) && n !== projectName)
  if (!projectName || !peopleName) {
    // fall back on the content: the sheet with e-mail addresses is the people sheet
    const rest = names.filter((n) => n !== projectName && n !== peopleName)
    if (!peopleName) peopleName = rest.find((n) => looksLikePeopleSheet(get(n).rows))
    if (!projectName) projectName = names.find((n) => n !== peopleName)
  }
  if (!projectName || !peopleName) {
    throw new Error("ไม่พบชีต 'Project List' และ 'Name List' ในไฟล์นี้")
  }
  const pr = get(projectName)
  const pe = get(peopleName)
  return { projectRows: pr.rows, peopleRows: pe.rows, peopleCells: pe.cells, sheets: { project: projectName, people: peopleName } }
}

// ---------------------------------------------------------------------------
// parsing the two sheets
// ---------------------------------------------------------------------------
const firstRowIndex = (rows, test, maxScan = 6) => {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) if (rows[i].some((c) => test(cellText(c)))) return i
  return -1
}

const EMAIL_HDR = /e-?\s?mail|อีเมล|อีเมล์/i
const EMAIL_ONLY_HDR = /^(e-?\s?mail|อีเมลล์?|อีเมล์?)(\s*address)?$/i
const COLUMN_NO_HDR = /^(no\.?|#|ลำดับ|ที่)$/i
const ID_HDR = /^(id|emp\.?\s*id|employee(\s*id)?|รหัส(พนักงาน)?|เลขที่พนักงาน)$/i
const NAME_HDR = /name|sername|surname|ชื่อ|นามสกุล/i
const PROJECT_NAME_HDR = /ชื่อโครงการ|project\s*name|โครงการ|^name$/i
const CO_HDR = /project\s*co|^co\.?\s*\d*$|ผู้ประสาน/i
// the WHOLE note cell: "Admin", "Admin 2", "แอดมิน", "ผู้ดูแลระบบ" - never "Office Admin", "not admin", "Administration"
export const ADMIN_NOTE = /^\s*(admin|แอดมิน|ผู้ดูแลระบบ)(\s*\d+)?\s*$/i

export function parsePeople(rows, cells) {
  const warnings = []
  const out = []
  const list = Array.isArray(rows) ? rows : []
  const hi = firstRowIndex(list, (t) => !t.includes('@') && EMAIL_HDR.test(t))
  let cols = { no: 0, name: 1, email: 2, id: 3 }
  if (hi >= 0) {
    const h = list[hi].map(cellText)
    const find = (re, skip = []) => h.findIndex((t, i) => !skip.includes(i) && t && re.test(t))
    const email = find(EMAIL_HDR)
    const no = find(COLUMN_NO_HDR, [email])
    const id = find(ID_HDR, [email, no])
    const name = find(NAME_HDR, [email, no, id])
    cols = {
      email,
      no: no >= 0 ? no : -1,
      id, // with a header row the column must be named ID: no guessing at column D
      name: name >= 0 ? name : [1, 0, 2].find((i) => i !== email && i !== no && i !== id) ?? -1,
    }
    if (id < 0) warnings.push("ไม่พบคอลัมน์ 'ID' ในชีต Name List — ทุกคนจะได้รหัสผ่านแบบสุ่ม")
  }
  const used = new Set(Object.values(cols))
  const startRow = hi >= 0 ? hi + 1 : 0
  const byEmail = new Map()
  for (let r = startRow; r < list.length; r++) {
    const row = list[r] || []
    if (row.every(isEmptyCell)) continue
    const rowNo = r + 1
    const rawEmail = cols.email >= 0 ? row[cols.email] : ''
    // a repeated header row in the middle of the data
    if (EMAIL_ONLY_HDR.test(cellText(rawEmail))) continue
    const name = cols.name >= 0 ? cellText(row[cols.name]) : ''
    const { email, problem } = readEmail(rawEmail)
    if (problem === 'empty') {
      if (name) warnings.push(`แถว ${rowNo} (Name List): ไม่มีอีเมล — ข้าม`)
      continue
    }
    if (problem === 'space') {
      warnings.push(`แถว ${rowNo} (Name List): อีเมลมีช่องว่างอยู่ภายใน — ข้าม (แก้ในไฟล์แล้วนำเข้าใหม่)`)
      continue
    }
    if (problem === 'lead') {
      warnings.push(`แถว ${rowNo} (Name List): อีเมลขึ้นต้นด้วยอักขระต้องห้าม (= + - @) — ข้าม`)
      continue
    }
    if (problem) {
      warnings.push(`แถว ${rowNo} (Name List): อีเมลไม่ถูกต้อง — ข้าม`)
      continue
    }
    if (FORMULA_LEAD.test(name)) {
      warnings.push(`แถว ${rowNo} (Name List): ชื่อขึ้นต้นด้วยอักขระต้องห้าม (= + - @) — ข้าม`)
      continue
    }
    const isAdminNote = row.some((c, i) => !used.has(i) && ADMIN_NOTE.test(cellText(c)))
    const prev = byEmail.get(email)
    if (prev) {
      warnings.push(`แถว ${rowNo} (Name List): อีเมลซ้ำกับแถว ${prev.rowNo} — ใช้ข้อมูลแถวแรก${isAdminNote ? ' (หมายเหตุ Admin ของแถวซ้ำไม่ถูกนำมาใช้)' : ''}`)
      continue
    }
    const id = cols.id >= 0 ? readId(row[cols.id], cells && cells[r] ? cells[r][cols.id] : undefined) : { status: 'missing', value: '' }
    const p = makePerson({ rowNo, name: name || email.split('@')[0], email, role: isAdminNote ? 'admin' : 'user', employeeId: id.value, idStatus: id.status })
    byEmail.set(email, p)
    out.push(p)
  }
  return { people: out, warnings }
}

// one Co cell may hold several coordinators: "A, B", "A / B", "A & B", "A และ B", "A; B", one per line
export const splitCoCell = (v) =>
  String(v ?? '')
    .split(/[,/;&\n\r]+|\sและ\s/)
    .map(cellText)
    .filter(Boolean)

export function parseProjects(rows) {
  const warnings = []
  const out = []
  const list = Array.isArray(rows) ? rows : []
  const hi = firstRowIndex(list, (t) => CO_HDR.test(t) || /ชื่อโครงการ|project\s*name/i.test(t))
  let nameCol = 0
  let coCols = [1, 2]
  if (hi >= 0) {
    const h = list[hi].map(cellText)
    const co = h.map((t, i) => (t && CO_HDR.test(t) ? i : -1)).filter((i) => i >= 0)
    const nm = h.findIndex((t, i) => t && !co.includes(i) && PROJECT_NAME_HDR.test(t))
    nameCol = nm >= 0 ? nm : h.findIndex((_, i) => !co.includes(i))
    if (nameCol < 0) nameCol = 0
    coCols = co.length ? co : h.map((_, i) => i).filter((i) => i !== nameCol && i < nameCol + 3).slice(0, 2)
    if (!coCols.length) coCols = [nameCol + 1, nameCol + 2]
  }
  const startRow = hi >= 0 ? hi + 1 : 0
  for (let r = startRow; r < list.length; r++) {
    const row = list[r] || []
    if (row.every(isEmptyCell)) continue
    const rowNo = r + 1
    const name = cellText(row[nameCol])
    const cos = []
    const seen = new Set()
    for (const c of coCols) {
      if (isNoneCell(row[c])) continue
      for (const t of splitCoCell(row[c])) {
        if (isNoneCell(t)) continue
        if (FORMULA_LEAD.test(t)) {
          warnings.push(`แถว ${rowNo} (Project List): Project Co "${t.slice(0, 30)}" ขึ้นต้นด้วยอักขระต้องห้าม — ข้าม`)
          continue
        }
        const k = normKey(t)
        if (seen.has(k)) continue
        seen.add(k)
        cos.push({ raw: t, isAdmin: k === ADMIN_CO })
      }
    }
    // a repeated header row
    if (/ชื่อโครงการ|project\s*name/i.test(name) && cos.every((c) => CO_HDR.test(c.raw))) continue
    if (!name) {
      if (cos.length) warnings.push(`แถว ${rowNo} (Project List): มี Project Co แต่ไม่มีชื่อโครงการ — ข้าม`)
      continue
    }
    out.push({ index: out.length, rowNo, name, co: cos })
  }
  return { projects: out, warnings }
}

export function parseImport({ projectRows, peopleRows, peopleCells }) {
  const pe = parsePeople(peopleRows, peopleCells)
  const pr = parseProjects(projectRows)
  if (pe.people.length > LIMITS.maxItems || pr.projects.length > LIMITS.maxItems) {
    throw new Error(`ไฟล์มีรายการมากเกินไป (สูงสุด ${LIMITS.maxItems} คน และ ${LIMITS.maxItems} โครงการต่อครั้ง) — แบ่งเป็นหลายไฟล์`)
  }
  const warnings = [...pe.warnings, ...pr.warnings]
  if (!pe.people.length) warnings.push('ไม่พบรายชื่อผู้ใช้ (ชีต Name List) ในไฟล์')
  if (!pr.projects.length) warnings.push('ไม่พบรายการโครงการ (ชีต Project List) ในไฟล์')
  return { people: pe.people, projects: pr.projects, warnings }
}

// IDs of people who already exist are not needed: drop them as early as possible
export function withoutExistingIds(parsed, users) {
  const have = new Set(users.map((u) => String(u.email || '').toLowerCase()))
  return {
    ...parsed,
    people: parsed.people.map((p) =>
      have.has(p.email) && p.hasId ? makePerson({ rowNo: p.rowNo, name: p.name, email: p.email, role: p.role, employeeId: '', idStatus: 'missing' }) : p
    ),
  }
}

// ---------------------------------------------------------------------------
// matching sheet projects to system projects
// ---------------------------------------------------------------------------
export const MATCH_MIN = 0.78 // below: no suggestion
export const EXACT = 0.999 // the only score that is ever applied without the admin pressing a button

const MARKER = /^(\d+[a-z]?|[a-z]|[a-z]\d+|phase|เฟส|ระยะ|zone|โซน|stage|block|บล็อก|โครงการที่)$/u
const trigrams = (c) => {
  const s = new Set()
  if (c.length < 3) s.add(c)
  for (let i = 0; i + 3 <= c.length; i++) s.add(c.slice(i, i + 3))
  return s
}
function prepName(s) {
  const k = normKey(s)
  const c = compact(k)
  return { k, c, tokens: k ? k.split(' ') : [], tri: trigrams(c) }
}

// a difference in a trailing / marker token (letter suffix, "Phase n", a number on one side only) is a MISMATCH
function markerMismatch(a, b) {
  const has = (arr, t) => arr.some((u) => u === t || (t.length > 2 && u.length > 2 && similarity(t, u) >= 0.8))
  const extra = [...a.tokens.filter((t) => !has(b.tokens, t)), ...b.tokens.filter((t) => !has(a.tokens, t))]
  if (extra.some((t) => MARKER.test(t))) return true
  const sa = /\d+[a-z]?$/.exec(a.c)?.[0]
  const sb = /\d+[a-z]?$/.exec(b.c)?.[0]
  return (sa || sb) && sa !== sb ? true : false
}

function scorePrepared(a, b) {
  if (!a.c || !b.c) return 0
  if (a.c === b.c) return 1
  if (markerMismatch(a, b)) return 0
  let best = similarity(a.c, b.c)
  const [short, long] = a.c.length <= b.c.length ? [a.c, b.c] : [b.c, a.c]
  if (short.length >= 4 && long.includes(short)) best = Math.max(best, Math.min(0.97, 0.82 + 0.15 * (short.length / long.length)))
  if (a.tokens.length > 1 || b.tokens.length > 1) {
    const [ts, tl] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens]
    const used = new Set()
    let sum = 0
    for (const t of ts) {
      let bi = -1
      let bs = 0
      tl.forEach((u, i) => {
        if (used.has(i)) return
        const s = t.length <= 2 || u.length <= 2 ? (t === u ? 1 : 0) : similarity(t, u)
        if (s > bs) {
          bs = s
          bi = i
        }
      })
      if (bi >= 0 && bs >= 0.8) {
        used.add(bi)
        sum += bs
      }
    }
    best = Math.max(best, (sum / ts.length) * (0.7 + 0.3 * (used.size / tl.length)))
  }
  return best
}

// 0..1 similarity of two project names (case/space/punctuation-insensitive, Thai-safe). 1 = same normalised name.
export const nameScore = (a, b) => scorePrepared(prepName(a), prepName(b))

// cheap similarity used to shortlist candidates (so 1000 x 1000 names stay fast): trigram overlap
const jaccard = (a, b) => {
  const [s, l] = a.tri.size <= b.tri.size ? [a.tri, b.tri] : [b.tri, a.tri]
  let shared = 0
  for (const t of s) if (l.has(t)) shared++
  return shared / (a.tri.size + b.tri.size - shared || 1)
}
const SHORTLIST = 8

// build ONCE per snapshot of the system projects
export function prepareProjectIndex(systemProjects) {
  return systemProjects.map((p) => ({ p, name: prepName(p.name), code: p.code ? prepName(p.code) : null }))
}

// Suggestions. ONLY an exact normalised match (score >= EXACT) is applied (`projectId`); everything else defaults to
// "skip" and is offered as `suggestion` (one click per row). A system project goes to at most ONE row automatically.
// -> [{ index, projectId, score, confidence: 'exact'|'suggest'|'ambiguous'|'none', suggestion: {id,score}|null, candidates }]
export function autoMapProjects(sheetProjects, systemProjects) {
  const idx = Array.isArray(systemProjects) && systemProjects[0] && systemProjects[0].name && systemProjects[0].p ? systemProjects : prepareProjectIndex(systemProjects)
  // exact normalised name (or code): O(1) per row
  const byC = new Map()
  for (const e of idx) for (const c of [e.name.c, e.code && e.code.c]) if (c) byC.set(c, [...new Set([...(byC.get(c) || []), e.p.id])])
  const rows = sheetProjects.map((sp) => {
    const pn = prepName(sp.name)
    const exactIds = pn.c ? byC.get(pn.c) || [] : []
    if (exactIds.length) return { index: sp.index, cand: exactIds.map((id) => ({ id, score: 1 })), exact: exactIds.map((id) => ({ id, score: 1 })) }
    // fuzzy: shortlist by trigram overlap, then score the best few in full
    const short = []
    for (const e of idx) {
      const j = Math.max(jaccard(pn, e.name), e.code && e.code.c.length >= 4 ? jaccard(pn, e.code) : 0)
      if (j >= 0.15) short.push({ e, j })
    }
    short.sort((x, y) => y.j - x.j)
    const cand = []
    for (const { e } of short.slice(0, SHORTLIST)) {
      // the project code only counts when it is long enough to be meaningful (a 1-3 letter code is noise)
      const score = Math.max(scorePrepared(pn, e.name), e.code && e.code.c.length >= 4 ? scorePrepared(pn, e.code) : 0)
      if (score > 0.5) cand.push({ id: e.p.id, score })
    }
    cand.sort((x, y) => y.score - x.score)
    return { index: sp.index, cand, exact: [] }
  })
  const taken = new Set()
  const result = rows.map((r) => ({ index: r.index, projectId: '', score: r.cand[0] ? r.cand[0].score : 0, confidence: r.exact.length > 1 ? 'ambiguous' : 'none', suggestion: null, candidates: [] }))
  rows.forEach((r, i) => {
    if (r.exact.length !== 1 || taken.has(r.exact[0].id)) return
    taken.add(r.exact[0].id)
    result[i].projectId = r.exact[0].id
    result[i].confidence = 'exact'
    result[i].score = 1
  })
  rows.forEach((r, i) => {
    const free = r.cand.filter((c) => !taken.has(c.id))
    result[i].candidates = free.slice(0, 3)
    if (result[i].confidence === 'exact' || result[i].confidence === 'ambiguous') return
    const top = free.find((c) => c.score >= MATCH_MIN && c.score < EXACT)
    if (top) {
      result[i].suggestion = top
      result[i].confidence = 'suggest'
    }
  })
  return result
}

export const mappingFromAuto = (auto) => Object.fromEntries(auto.map((a) => [a.index, a.projectId]))

// ---------------------------------------------------------------------------
// matching a Project Co name to a person of the Name List
// ---------------------------------------------------------------------------
// Titles are ignored on both sides ("คุณสมชาย ใจดี" ~ "นายสมชาย ใจดี", "Mr. John Smith" ~ "John Smith").
const stripTitle = (k) => {
  const s = k.replace(/^(mr|mrs|ms|miss|dr)\s+(?=\S)/, '').replace(/^(นางสาว|นาง|นาย|คุณ|ดร|น ส|นส)\s*(?=\S)/, '')
  return s || k
}
export const FUZZY_MIN_LENGTH = 12

// Index of the Name List, built ONCE per file. match() is memoised per Co string.
// -> { status: 'matched' | 'candidate' | 'ambiguous' | 'none', person?, how? }
//   matched   : exact normalised name (after title strip) of a multi-word name, unique -> applied automatically
//   candidate : single-word name, token subset, or (>= 12 chars) near-identical -> only applied if the admin ticks it
export function makePersonIndex(people) {
  const keyed = people.map((p) => {
    const k = stripTitle(normKey(p.name))
    return { p, k, c: compact(k), t: k.split(' ') }
  }).filter((x) => x.k)
  const byCompact = new Map()
  for (const x of keyed) byCompact.set(x.c, [...(byCompact.get(x.c) || []), x])
  const cache = new Map()
  const compute = (coName) => {
    const key = stripTitle(normKey(coName))
    if (!key) return { status: 'none' }
    const kt = key.split(' ')
    const cKey = compact(key)
    const exact = byCompact.get(cKey) || []
    if (exact.length > 1) return { status: 'ambiguous', how: 'exact' }
    if (exact.length === 1) return { status: kt.length === 1 ? 'candidate' : 'matched', person: exact[0].p, how: 'exact' }
    const tok = keyed.filter((x) => kt.every((w) => x.t.includes(w)))
    if (tok.length > 1) return { status: 'ambiguous', how: 'tokens' }
    if (tok.length === 1) return { status: 'candidate', person: tok[0].p, how: 'tokens' }
    if (cKey.length >= FUZZY_MIN_LENGTH) {
      const scored = keyed.map((x) => ({ x, s: similarity(x.c, cKey) })).sort((a, b) => b.s - a.s)
      if (scored[0] && scored[0].s >= 0.88) {
        if (scored[1] && scored[0].s - scored[1].s < 0.04) return { status: 'ambiguous', how: 'fuzzy' }
        return { status: 'candidate', person: scored[0].x.p, how: 'fuzzy' }
      }
    }
    return { status: 'none' }
  }
  return {
    match(coName) {
      if (!cache.has(coName)) cache.set(coName, compute(coName))
      return cache.get(coName)
    },
  }
}
export const matchPerson = (coName, people) => makePersonIndex(people).match(coName)

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------
// Project Co text exactly as stored: the names of the sheet joined by ", " (see splitCoNames in tracking.js)
export const coTextOf = (sheetProject) => sheetProject.co.map((c) => c.raw).join(', ')
export const coKey = (sp, c) => `${sp.index}|${normKey(c.raw)}`

const isBlank = (s) => !String(s ?? '').trim()

// Member actions: add | upgrade | keep | skip_global | skip_inactive | unmatched | ambiguous | candidate | admin_text | duplicate
// users: [{ id, email, role, active, full_name }]; projects: [{ id, code, name, project_co }]
// memberships: [{ project_id, user_id, role }]; mapping: { [rowIndex]: projectId | '' }
// acceptedCandidates: keys (coKey) of near-name Co candidates the admin ticked; auto: autoMapProjects() result
// (to count exact vs manual); adminRandomPassword: random password for role admin even when ids are used.
export function buildPlan({
  parsed,
  users = [],
  projects = [],
  memberships = [],
  mapping = {},
  useIdPassword = true,
  adminRandomPassword = false,
  acceptedCandidates = [],
  auto = [],
  personIndex,
}) {
  const warnings = [...(parsed.warnings || [])]
  const blockers = []
  const accepted = acceptedCandidates instanceof Set ? acceptedCandidates : new Set(acceptedCandidates)
  const pindex = personIndex || makePersonIndex(parsed.people)
  const userByEmail = new Map(users.map((u) => [String(u.email || '').toLowerCase(), u]))
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const memberRole = new Map(memberships.map((m) => [`${m.project_id}|${m.user_id}`, m.role]))
  const autoByIndex = new Map(auto.map((a) => [a.index, a]))

  // ----- people
  const people = parsed.people.map((p) => {
    const existing = userByEmail.get(p.email)
    const row = { email: p.email, name: p.name, role: p.role, hasId: p.hasId, idStatus: p.idStatus, rowNo: p.rowNo, warnings: [] }
    if (existing) {
      row.status = 'exists'
      row.userId = existing.id
      row.existingRole = existing.role
      row.active = existing.active !== false
      if (p.role === 'admin' && existing.role !== 'admin') {
        row.warnings.push('ในไฟล์ระบุเป็น Admin แต่บัญชีนี้ในระบบไม่ใช่แอดมิน — ไม่ได้แก้ไข (ปรับได้เองที่หน้าผู้ใช้)')
      }
      return row
    }
    row.status = 'create'
    row.passwordMode = 'random'
    if (useIdPassword) {
      if (p.idStatus === 'missing') row.warnings.push('ไม่มีรหัสพนักงาน — จะสร้างด้วยรหัสสุ่ม (แสดงครั้งเดียวหลังนำเข้า)')
      else if (p.idStatus === 'unusable') {
        row.warnings.push('รหัสพนักงานอยู่ในรูปแบบที่ใช้ไม่ได้ (วันที่ ทศนิยม รูปแบบ E+ หรืออักขระต้องห้าม) — จะสร้างด้วยรหัสสุ่ม (แสดงครั้งเดียวหลังนำเข้า)')
      } else if (p.role === 'admin' && adminRandomPassword) {
        row.adminRandom = true
      } else {
        row.passwordMode = 'id'
        if (p.idStatus === 'numeric') row.warnings.push('ID เป็นตัวเลข — เลขศูนย์นำหน้าอาจหายไป ตรวจสอบ')
        if (idLength(p) < 6) row.warnings.push('รหัสพนักงานสั้นกว่า 6 ตัวอักษร — Supabase น่าจะปฏิเสธ (ระบบจะรายงานเป็นรายคน)')
      }
    }
    return row
  })
  const personByEmail = new Map(people.map((p) => [p.email, p]))
  for (const p of people) for (const w of p.warnings) warnings.push(`${p.name}: ${w}`)

  // ----- projects
  const claimedCo = new Map() // projectId -> text planned by an earlier row
  const plannedRole = new Map() // `${projectId}|${userId or email}` -> role planned by an earlier row
  const rows = parsed.projects.map((sp) => {
    const projectId = mapping[sp.index] || ''
    const proj = projectId ? projectById.get(projectId) : null
    const row = {
      index: sp.index,
      rowNo: sp.rowNo,
      sheetName: sp.name,
      projectId: proj ? proj.id : '',
      project: proj ? { id: proj.id, code: proj.code, name: proj.name } : null,
      co: [],
      coText: { action: 'skip', value: '', existing: '' },
      changes: 0,
    }
    if (!proj) {
      row.skipped = true
      row.co = sp.co.map((c) => ({ raw: c.raw, isAdmin: c.isAdmin, action: 'skipped' }))
      return row
    }
    const a = autoByIndex.get(sp.index)
    row.matchedBy = a && a.confidence === 'exact' && a.projectId === proj.id ? 'exact' : 'manual'
    // (a) Project Co text
    const value = coTextOf(sp)
    const existingText = claimedCo.has(proj.id) ? claimedCo.get(proj.id) : proj.project_co
    row.coText.existing = existingText || ''
    row.coText.value = value
    if (!value) row.coText.action = 'none'
    else if (!isBlank(existingText)) row.coText.action = 'keep'
    else {
      row.coText.action = 'set'
      claimedCo.set(proj.id, value)
    }
    // (b) memberships of the named people
    const seenInRow = new Set()
    for (const c of sp.co) {
      const entry = { raw: c.raw, isAdmin: c.isAdmin, key: coKey(sp, c) }
      if (c.isAdmin) {
        entry.action = 'admin_text'
        row.co.push(entry)
        continue
      }
      const m = pindex.match(c.raw)
      let person = null
      if (m.status === 'none') {
        entry.action = 'unmatched'
        warnings.push(`โครงการ "${sp.name}": ไม่พบ "${c.raw}" ใน Name List — ไม่ได้เพิ่มเป็นผู้ดูแลโครงการ`)
      } else if (m.status === 'ambiguous') {
        entry.action = 'ambiguous'
        warnings.push(`โครงการ "${sp.name}": "${c.raw}" ตรงกับหลายคนใน Name List — ไม่ได้เพิ่มเป็นผู้ดูแลโครงการ`)
      } else if (m.status === 'candidate' && !accepted.has(entry.key)) {
        entry.action = 'candidate'
        entry.candidate = { name: m.person.name, email: m.person.email, how: m.how }
        warnings.push(`โครงการ "${sp.name}": "${c.raw}" อาจตรงกับ "${m.person.name}" (ชื่อใกล้เคียง) — ยังไม่ได้ใช้ ติ๊กยืนยันในรายการถ้าถูกต้อง`)
      } else {
        person = personByEmail.get(m.person.email)
        entry.accepted = m.status === 'candidate'
      }
      if (person) {
        entry.email = person.email
        entry.name = person.name
        entry.how = m.how
        const user = userByEmail.get(person.email)
        if (seenInRow.has(person.email)) {
          entry.action = 'duplicate'
          row.co.push(entry)
          continue
        }
        seenInRow.add(person.email)
        if (user) {
          entry.userId = user.id
          if (user.role === 'admin' || user.role === 'exec') entry.action = 'skip_global'
          else if (user.active === false) {
            entry.action = 'skip_inactive'
            warnings.push(`โครงการ "${sp.name}": บัญชีของ ${person.name} ปิดการใช้งานอยู่ — ไม่ได้เพิ่มเป็นผู้ดูแลโครงการ`)
          } else {
            const cur = plannedRole.get(`${proj.id}|${user.id}`) || memberRole.get(`${proj.id}|${user.id}`) || null
            entry.current = cur
            if (cur === 'manager') entry.action = 'keep'
            else {
              entry.action = cur ? 'upgrade' : 'add'
              plannedRole.set(`${proj.id}|${user.id}`, 'manager')
            }
          }
        } else if (person.role === 'admin') {
          entry.action = 'skip_global' // will be created as a global admin
          entry.pending = true
        } else {
          const k = `${proj.id}|${person.email}`
          if (plannedRole.get(k) === 'manager') entry.action = 'keep'
          else {
            entry.action = 'add'
            plannedRole.set(k, 'manager')
          }
          entry.pending = true // the account is created by this very run
        }
        entry.current = entry.current ?? null
      }
      row.co.push(entry)
    }
    row.changes = (row.coText.action === 'set' ? 1 : 0) + row.co.filter((c) => c.action === 'add' || c.action === 'upgrade').length
    return row
  })

  for (const r of rows) {
    if (r.skipped) warnings.push(`โครงการ "${r.sheetName}": ยังไม่ได้เลือกโครงการในระบบ — ข้าม`)
  }
  const used = new Map()
  for (const r of rows) {
    if (!r.projectId) continue
    if (used.has(r.projectId)) {
      blockers.push(`โครงการ "${r.sheetName}" และ "${used.get(r.projectId)}" เลือกโครงการในระบบเดียวกัน — เลือกให้ไม่ซ้ำก่อนจึงจะยืนยันได้`)
    } else used.set(r.projectId, r.sheetName)
  }

  const count = (list, f) => list.filter(f).length
  const allCo = rows.flatMap((r) => r.co)
  const globalAdmins = people.filter((p) => p.status === 'create' && p.role === 'admin').map((p) => ({ name: p.name, email: p.email, passwordMode: p.passwordMode }))
  const counts = {
    peopleTotal: people.length,
    peopleCreate: count(people, (p) => p.status === 'create'),
    peopleCreateAdmin: globalAdmins.length,
    peopleCreateAdminWithId: globalAdmins.filter((a) => a.passwordMode === 'id').length,
    peopleCreateWithId: count(people, (p) => p.status === 'create' && p.passwordMode === 'id'),
    peopleCreateRandom: count(people, (p) => p.status === 'create' && p.passwordMode === 'random'),
    peopleExists: count(people, (p) => p.status === 'exists'),
    projectsTotal: rows.length,
    projectsMapped: count(rows, (r) => !r.skipped),
    projectsExact: count(rows, (r) => r.matchedBy === 'exact'),
    projectsManual: count(rows, (r) => r.matchedBy === 'manual'),
    projectsSkipped: count(rows, (r) => r.skipped),
    coSet: count(rows, (r) => r.coText.action === 'set'),
    coKeep: count(rows, (r) => r.coText.action === 'keep'),
    mgrAdd: count(allCo, (c) => c.action === 'add'),
    mgrUpgrade: count(allCo, (c) => c.action === 'upgrade'),
    mgrKeep: count(allCo, (c) => c.action === 'keep'),
    mgrSkipGlobal: count(allCo, (c) => c.action === 'skip_global'),
    mgrCandidates: count(allCo, (c) => c.action === 'candidate'),
    warnings: warnings.length,
  }
  counts.changes = counts.peopleCreate + counts.coSet + counts.mgrAdd + counts.mgrUpgrade
  return { people, projects: rows, warnings, blockers, globalAdmins, counts, useIdPassword, empty: counts.changes === 0, canConfirm: blockers.length === 0 }
}

export const rowHasWork = (row) => !row.skipped && row.changes > 0

// A short signature of what a run would do, to notice that the data changed between preview and confirm.
export const planSignature = (plan) =>
  JSON.stringify([
    plan.people.filter((p) => p.status === 'create').map((p) => [p.email, p.role, p.passwordMode]),
    plan.projects.map((r) => [r.projectId, r.coText.action, r.coText.value, r.co.map((c) => [c.email || c.raw, c.action])]),
  ])
