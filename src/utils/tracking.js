// Pure helpers for the Project Tracking feature (no Supabase / React imports,
// so they can be reused anywhere and checked in isolation).
//
// Dates are stored as ISO yyyy-mm-dd and displayed in Buddhist Era
// (e.g. 2026-10-15 -> "15 ต.ค. 69"). "Today" is always Thailand's date, the
// same definition the database uses (public.tcm_today()).

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
// Lenient prefix match: used when DISPLAYING / measuring values that came from
// the DB (which may be a date or a timestamp string).
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/
// Strict, end-anchored: used when VALIDATING user input.
const ISO_DATE_STRICT = /^(\d{4})-(\d{2})-(\d{2})$/

// ---------- dates ----------
export function todayTH() {
  // Build yyyy-mm-dd from parts rather than relying on any locale's string format.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

// Exactly yyyy-mm-dd AND a real calendar date (2026-02-31 and '2026-10-15x' are rejected).
export function isIsoDate(v) {
  const m = ISO_DATE_STRICT.exec(typeof v === 'string' ? v : '')
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

export const INSANE_DATE_MESSAGE = 'ปีไม่สมเหตุสมผล (ตรวจว่ากรอกปี ค.ศ. ไม่ใช่ พ.ศ.)'

// Year must be within today's Gregorian year -10..+10. The native date input
// shows Gregorian years, so a Buddhist-year typo (2569) is the realistic mistake.
export function isSaneDate(iso) {
  if (!isIsoDate(iso)) return false
  const year = +iso.slice(0, 4)
  const thisYear = +todayTH().slice(0, 4)
  return year >= thisYear - 10 && year <= thisYear + 10
}

// "15 ต.ค. 69"  (long: "15 ต.ค. 2569")
export function fmtThaiDate(iso, { long = false } = {}) {
  const m = ISO_DATE.exec(iso || '')
  if (!m) return '-'
  const be = +m[1] + 543
  return `${+m[3]} ${TH_MONTHS[+m[2] - 1]} ${long ? be : String(be).slice(-2)}`
}

// timestamptz -> "15 ต.ค. 69 14:32" in Thailand time
export function fmtThaiDateTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value])
  )
  return `${fmtThaiDate(`${parts.year}-${parts.month}-${parts.day}`)} ${parts.hour}:${parts.minute}`
}

const toUtc = (iso) => {
  const m = ISO_DATE.exec(iso || '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
}

// whole days from a to b (b - a)
export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000)
}

// "อีก 9 วัน" / "ครบกำหนดวันนี้" / "เลยกำหนด 3 วัน"
export function countdownText(days) {
  if (days == null || Number.isNaN(days)) return ''
  if (days > 0) return `อีก ${days} วัน`
  if (days === 0) return 'ครบกำหนดวันนี้'
  return `เลยกำหนด ${-days} วัน`
}

// Time-elapsed % at a given date, same formula as the DB view
// (project_progress_latest.time_elapsed_pct): clamp(round(100*(d-start)/(end-start)))
export function elapsedPctAt(start, end, iso) {
  if (!start || !end || end <= start) return null
  const pct = (100 * (toUtc(iso) - toUtc(start))) / (toUtc(end) - toUtc(start))
  return Math.min(100, Math.max(0, Math.round(pct)))
}

// ---------- installment status ----------
export const STATUS_FLOW = ['planned', 'deliverable_done', 'ready_to_bill', 'billed', 'under_review', 'approved', 'paid']
export const ALL_STATUSES = [...STATUS_FLOW, 'returned', 'cancelled']

export const STATUS_LABEL = {
  planned: 'วางแผนไว้',
  deliverable_done: 'ส่งมอบงานแล้ว',
  ready_to_bill: 'พร้อมเบิก',
  billed: 'เบิกแล้ว',
  under_review: 'ผู้ว่าจ้างกำลังตรวจ',
  approved: 'อนุมัติแล้ว',
  paid: 'ได้รับชำระแล้ว',
  returned: 'ตีกลับ',
  cancelled: 'ยกเลิก',
}

// tone drives the badge colour class (trk-tone-*)
export const STATUS_TONE = {
  planned: 'mute',
  deliverable_done: 'info',
  ready_to_bill: 'info',
  billed: 'ok',
  under_review: 'ok',
  approved: 'ok',
  paid: 'ok',
  returned: 'bad',
  cancelled: 'mute',
}

export const BILLED_STATUSES = ['billed', 'under_review', 'approved', 'paid']
export const OPEN_STATUSES = ['planned', 'deliverable_done', 'ready_to_bill', 'returned']
// statuses where a previously recorded billed_date no longer applies
export const CLEARS_BILLED_DATE = ['planned', 'deliverable_done', 'ready_to_bill', 'cancelled']

export const installmentName = (inst) => `งวดที่ ${inst.installment_no}`

// Is moving from -> to a step backwards (or a reactivation/cancel) that deserves a confirm?
export function isBackwardMove(from, to) {
  if (from === to) return false
  if (to === 'cancelled') return true
  if (from === 'cancelled') return true
  const a = STATUS_FLOW.indexOf(from)
  const b = STATUS_FLOW.indexOf(to)
  if (a === -1 || b === -1) return false // involves 'returned': that is a legitimate sideways move
  return b < a
}

export function nextStatusInFlow(status) {
  const i = STATUS_FLOW.indexOf(status)
  if (i === -1) return 'ready_to_bill' // returned -> re-bill
  return STATUS_FLOW[Math.min(i + 1, STATUS_FLOW.length - 1)]
}

// One human-readable line per installment: "งวดที่ 1 เบิกแล้ว ✓" ...
export function installmentHeadline(inst) {
  const name = installmentName(inst)
  const date = inst.planned_bill_date
  const due = date
    ? `ต้องเบิกภายในวันที่ ${fmtThaiDate(date)}${inst.days_until_planned != null ? ` (${countdownText(inst.days_until_planned)})` : ''}`
    : 'ยังไม่กำหนดวันเบิก'
  switch (inst.status) {
    case 'paid':
      return { text: `${name} ได้รับชำระแล้ว ✓`, tone: 'ok' }
    case 'approved':
      return { text: `${name} อนุมัติแล้ว ✓`, tone: 'ok' }
    case 'under_review':
      return { text: `${name} เบิกแล้ว ✓ ผู้ว่าจ้างกำลังตรวจ`, tone: 'ok' }
    case 'billed':
      return { text: `${name} เบิกแล้ว ✓${inst.billed_date ? ` (${fmtThaiDate(inst.billed_date)})` : ''}`, tone: 'ok' }
    case 'cancelled':
      return { text: `${name} ยกเลิก`, tone: 'mute' }
    case 'returned':
      return { text: `${name} ถูกตีกลับ — ${due}`, tone: 'bad' }
    default:
      return { text: `${name} ${due}`, tone: inst.is_overdue ? 'bad' : 'info' }
  }
}

// ---------- docs readiness ----------
export function docsStateText(state, total, attached) {
  if (state === 'ready') return { text: 'เอกสารพร้อม', tone: 'ok' }
  if (state === 'missing') return { text: `ขาด ${Math.max(0, (total || 0) - (attached || 0))} รายการ`, tone: 'bad' }
  return { text: 'ยังไม่ตั้งเช็กลิสต์', tone: 'mute' }
}

// ---------- health (no money; the rule is shown to users in the "ดูเกณฑ์" panel) ----------
export const STALE_DAYS = 14
export const BEHIND_POINTS = 15
export const READY_TO_BILL_DAYS = 7
export const DUE_SOON_DAYS = 7
export const CLOSED_PROJECT_STATUS = 'ปิดโครงการ'

export const HEALTH_LABEL = { red: 'ต้องดำเนินการ', amber: 'ควรติดตาม', green: 'ปกติ' }

// row: a project_tracking_overview row (+ optional ready_to_bill_days).
// Closed projects skip the progress-based rules (stale / behind schedule) but
// still get the installment rules.
export function computeHealth(row, { readyToBillDays } = {}) {
  const closed = row.project_status === CLOSED_PROJECT_STATUS
  const rtb = readyToBillDays !== undefined ? readyToBillDays : row.ready_to_bill_days
  const red = []
  const amber = []

  if ((row.installments_overdue || 0) > 0) red.push(`เลยกำหนดเบิก ${row.installments_overdue} งวด`)

  if (!closed && row.percent_complete != null && row.time_elapsed_pct != null) {
    const gap = row.time_elapsed_pct - row.percent_complete
    if (gap > BEHIND_POINTS) red.push(`ความคืบหน้าตามหลังเวลา ${gap} จุด`)
  }

  if (rtb != null && rtb > READY_TO_BILL_DAYS) amber.push(`พร้อมเบิกค้างมา ${rtb} วัน`)

  const d = row.next_days_until_planned
  if (row.next_installment_id && d != null && d >= 0 && d <= DUE_SOON_DAYS && row.next_docs_state === 'missing') {
    amber.push(`งวดที่ ${row.next_installment_no} ครบกำหนด${d === 0 ? 'วันนี้' : `ใน ${d} วัน`} แต่เอกสารยังขาด`)
  }

  if (!closed) {
    if (row.days_since_update == null) amber.push('ยังไม่เคยอัปเดต % ความคืบหน้า')
    else if (row.days_since_update > STALE_DAYS) amber.push(`ไม่ได้อัปเดต % มา ${row.days_since_update} วัน`)
  }

  const level = red.length ? 'red' : amber.length ? 'amber' : 'green'
  return { level, reasons: [...red, ...amber], closed }
}

export const HEALTH_ORDER = { red: 0, amber: 1, green: 2 }

export function isStale(row) {
  // closed projects are not expected to keep reporting progress
  if (row.project_status === CLOSED_PROJECT_STATUS) return false
  return row.days_since_update == null || row.days_since_update > STALE_DAYS
}

// "next installment" line for the overview card
export function nextInstallmentLine(row) {
  if (!row.next_installment_id) {
    if (!row.installments_total) return { text: 'ยังไม่มีงวดงาน', tone: 'mute' }
    return { text: 'ไม่มีงวดที่ค้างเบิก', tone: 'ok' }
  }
  const no = `งวดที่ ${row.next_installment_no}`
  const prefix = row.next_status === 'returned' ? 'ตีกลับ · ' : ''
  if (!row.next_planned_bill_date) return { text: `${prefix}${no} · ยังไม่กำหนดวันเบิก`, tone: 'mute' }
  const d = row.next_days_until_planned
  const when =
    d != null && d < 0
      ? `${fmtThaiDate(row.next_planned_bill_date)} (${countdownText(d)})`
      : `เบิกภายใน ${fmtThaiDate(row.next_planned_bill_date)}${d != null ? ` (${countdownText(d)})` : ''}`
  return { text: `${prefix}${no} · ${when}`, tone: d != null && d < 0 ? 'bad' : 'info' }
}

// ---------- "my projects" (convention only; never enforced) ----------
const normName = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

// project_co may list several coordinators separated by , / ; & or "และ"
export function isMine(projectCo, localName) {
  const me = normName(localName)
  if (!me || !projectCo) return false
  return projectCo
    .split(/[,/;&]|\sและ\s/)
    .map(normName)
    .filter(Boolean)
    .includes(me)
}

// ---------- progress trend ----------
// History arrives newest-first. Chart keeps ONE point per as_of date (the most
// recently recorded entry wins), oldest first.
export function dailyProgressSeries(history) {
  const byDate = new Map()
  const sorted = [...history].sort((a, b) =>
    a.as_of === b.as_of ? (a.created_at < b.created_at ? 1 : -1) : a.as_of < b.as_of ? 1 : -1
  )
  for (const h of sorted) if (!byDate.has(h.as_of)) byDate.set(h.as_of, h)
  return [...byDate.values()].sort((a, b) => (a.as_of < b.as_of ? -1 : 1))
}
