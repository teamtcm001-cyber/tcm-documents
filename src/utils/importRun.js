// Executes an import plan (see importPlan.js) step by step. No Supabase import: every side effect goes through
// `deps`, so the stop / continue rules can be unit-tested in node.
//
//   deps.createUser({ email, fullName, role, initialPassword? })  -> { user: { id }, temporaryPassword? }   (adminCreateUser)
//   deps.refreshUsers()                                           -> [{ id, email }]                       (adminListUsers)
//   deps.setProjectCo(projectId, text)                            -> 'set' | 'kept'  (conditional write: only while project_co is still empty)
//   deps.setManager(projectId, userId)                            -> void  (setMembership(..., 'manager'))
//
// Rules:
//  * strictly sequential;
//  * the WHOLE run stops on session / rights / rate-limit / availability problems (401, 403, 429, 503, network):
//    what was already done is reported, the rest is listed as "not run";
//  * a failure of one person never aborts the others, and a person whose account could not be created gets no
//    memberships;
//  * email_exists = the account is there already (treated as existing);
//  * orphan_auth_user is NEVER adopted in bulk;
//  * employee ids are read here from the parsed people, sent only inside the create request, and never copied into
//    steps / results / messages.
import { getInitialPassword } from './importPlan.js'

export const WEAK_PASSWORD_HINT =
  'รหัสผ่านเริ่มต้นสั้นหรือง่ายเกินไปตามนโยบายของ Supabase — ปรับ Minimum password length ใน Supabase Auth หรือใช้รหัสสุ่ม'
export const ORPHAN_HINT = 'ต้องสร้างทีละคนในหน้าผู้ใช้ (บัญชีเดิมไม่มีโปรไฟล์)'

const FATAL_CODES = new Set([
  'unauthorized',
  'forbidden',
  'no_access',
  'rate_limited',
  'auth_unavailable',
  'password_change_required',
  'account_disabled',
  'audit_unavailable',
  'network',
  'not_available',
  '42501',
  'PGRST301',
  'PGRST002',
])
const FATAL_STATUS = new Set([401, 403, 429, 503])

const codeOf = (err) => String(err?.code || err?.cause?.code || '')
const statusOf = (err) => err?.status ?? err?.cause?.status

// -> { fatal, code, message }
export function classifyFailure(err, fallback = 'ดำเนินการไม่สำเร็จ') {
  const code = codeOf(err)
  const status = statusOf(err)
  const fatal = FATAL_CODES.has(code) || FATAL_STATUS.has(status)
  let message = typeof err?.message === 'string' && err.message ? err.message : fallback
  if (code === 'weak_password') message = WEAK_PASSWORD_HINT
  else if (code === 'orphan_auth_user') message = ORPHAN_HINT
  return { fatal, code: code || 'error', message }
}

// failures that look like the server / GoTrue struggling (throttling is mapped to 502 upstream_error by the API)
const SOFT_CODES = new Set(['upstream_error', 'error', 'profile_create_failed', 'pw_marker_failed', 'bad_response'])
export const MAX_CONSECUTIVE_SOFT_FAILURES = 3
const isSoftFailure = (f, err) => {
  const status = statusOf(err)
  return !f.fatal && (SOFT_CODES.has(f.code) || /^http_5/.test(f.code) || (typeof status === 'number' && status >= 500))
}

export function countPlanSteps(plan) {
  let n = plan.people.filter((p) => p.status === 'create').length
  for (const r of plan.projects) {
    if (r.skipped) continue
    if (r.coText.action === 'set') n++
    n += r.co.filter((c) => c.action === 'add' || c.action === 'upgrade').length
  }
  return n
}

// onStep(step): called when a step starts ({ status: 'running' }) and when it ends; steps have a stable id.
// Accounting: result.ok + result.failed + result.skipped + result.notRun === result.total (planned steps; the optional
// "lookup" step is not counted). runImport never throws: an unexpected error ends the run as `stopped`.
export async function runImport({ plan, parsed, deps, onStep = () => {} }) {
  const total = countPlanSteps(plan)
  const steps = []
  const created = []
  const existed = []
  const failedPeople = []
  const result = {
    total,
    steps,
    created,
    existed,
    failedPeople,
    coSet: 0,
    coKept: 0,
    coFailed: [],
    managerOk: [],
    managerFailed: [],
    managerSkipped: [],
    stopped: null,
    ok: 0,
    failed: 0,
    skipped: 0,
    notRun: total,
    done: 0, // = ok (kept for older callers)
  }
  try {
    await execute()
  } catch {
    if (!result.stopped) result.stopped = { code: 'unexpected', message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างนำเข้า' }
    const running = steps.find((s) => s.status === 'running')
    if (running) {
      running.status = 'fail'
      running.detail = 'เกิดข้อผิดพลาดที่ไม่คาดคิด'
      if (running.kind !== 'lookup') result.failed++
    }
  }
  result.done = result.ok
  result.notRun = Math.max(0, total - result.ok - result.failed - result.skipped)
  return result

  async function execute() {
    const parsedByEmail = new Map(parsed.people.map((p) => [p.email, p]))
    const idByEmail = new Map(plan.people.filter((p) => p.status === 'exists').map((p) => [p.email, p.userId]))
    const failedEmail = new Map()
    const noMember = new Map() // email -> reason (an account found later is admin / exec / inactive)
    const needLookup = []
    let seq = 0
    let soft = 0 // consecutive upstream-style failures

    const begin = (kind, label) => {
      const step = { id: ++seq, kind, label, status: 'running', detail: '' }
      steps.push(step)
      onStep({ ...step })
      return step
    }
    const end = (step, status, detail = '') => {
      step.status = status
      step.detail = detail
      if (step.kind !== 'lookup') {
        if (status === 'ok') result.ok++
        else if (status === 'fail') result.failed++
        else if (status === 'skip') result.skipped++
      }
      onStep({ ...step })
    }
    const stop = (step, failure) => {
      end(step, 'fail', failure.message)
      result.stopped = { code: failure.code, message: failure.message }
    }
    // after a failed step: stop on fatal problems, or after 3 upstream-style failures in a row
    const afterFailure = (step, f, err) => {
      if (f.fatal) {
        stop(step, f)
        return
      }
      end(step, 'fail', f.message)
      soft = isSoftFailure(f, err) ? soft + 1 : 0
      if (soft >= MAX_CONSECUTIVE_SOFT_FAILURES) {
        result.stopped = {
          code: 'too_many_failures',
          message: `ระบบตอบกลับผิดพลาดติดต่อกัน ${soft} ครั้ง (อาจถูกจำกัดอัตราหรือระบบขัดข้อง) — หยุดการนำเข้าเพื่อความปลอดภัย`,
        }
      }
    }

    // ---- 1. people
    for (const p of plan.people) {
      if (p.status !== 'create' || result.stopped) continue
      const step = begin('create', `สร้างบัญชี ${p.name}`)
      const person = parsedByEmail.get(p.email)
      const initialPassword = p.passwordMode === 'id' ? getInitialPassword(person) : null
      try {
        const res = await deps.createUser({
          email: p.email,
          fullName: p.name,
          role: p.role,
          ...(initialPassword ? { initialPassword } : {}),
        })
        idByEmail.set(p.email, res?.user?.id)
        const rec = { email: p.email, name: p.name, role: p.role, passwordMode: initialPassword ? 'id' : 'random' }
        // the random temporary password is shown once in the result; an employee-id password is never echoed
        if (!initialPassword && typeof res?.temporaryPassword === 'string') rec.temporaryPassword = res.temporaryPassword
        created.push(rec)
        soft = 0
        end(step, 'ok', initialPassword ? 'ใช้รหัสพนักงานเป็นรหัสผ่านเริ่มต้น' : 'ใช้รหัสสุ่ม')
      } catch (err) {
        const f = classifyFailure(err, 'สร้างบัญชีไม่สำเร็จ')
        if (f.code === 'email_exists') {
          needLookup.push(p.email)
          existed.push({ email: p.email, name: p.name, reason: 'มีบัญชีนี้อยู่แล้ว (เพิ่งมีการสร้างระหว่างนำเข้า)' })
          soft = 0
          end(step, 'skip', 'มีบัญชีอยู่แล้ว — ไม่แก้ไข')
        } else {
          failedEmail.set(p.email, f.message)
          failedPeople.push({ email: p.email, name: p.name, code: f.code, message: f.message })
          afterFailure(step, f, err)
        }
      }
    }

    // someone created by another admin meanwhile: look the id up once (an admin / exec / disabled account is never
    // made a project manager)
    if (needLookup.length && !result.stopped) {
      const step = begin('lookup', 'อ่านรายชื่อผู้ใช้อีกครั้ง')
      try {
        const list = await deps.refreshUsers()
        const byEmail = new Map((list || []).map((u) => [String(u.email || '').toLowerCase(), u]))
        for (const e of needLookup) {
          const u = byEmail.get(e)
          if (!u || !u.id) failedEmail.set(e, 'ไม่พบบัญชีในระบบ')
          else {
            idByEmail.set(e, u.id)
            if (u.role === 'admin' || u.role === 'exec') noMember.set(e, 'เป็นแอดมิน/ผู้บริหาร')
            else if (u.active === false) noMember.set(e, 'บัญชีปิดการใช้งาน')
          }
        }
        end(step, 'ok')
      } catch (err) {
        const f = classifyFailure(err, 'อ่านรายชื่อผู้ใช้ไม่สำเร็จ')
        for (const e of needLookup) failedEmail.set(e, f.message)
        if (f.fatal) stop(step, f)
        else end(step, 'fail', f.message)
      }
    }

    // ---- 2. projects
    for (const row of plan.projects) {
      if (row.skipped || result.stopped) continue
      const pname = row.project ? `${row.project.code ? row.project.code + ' ' : ''}${row.project.name}` : row.sheetName
      if (row.coText.action === 'set') {
        const step = begin('co', `ตั้ง Project Co ของ ${pname}`)
        try {
          const r = await deps.setProjectCo(row.projectId, row.coText.value)
          soft = 0
          if (r === 'kept') {
            result.coKept++
            end(step, 'skip', 'มีผู้กรอก Project Co แล้วระหว่างนำเข้า — ไม่แก้')
          } else {
            result.coSet++
            end(step, 'ok', row.coText.value)
          }
        } catch (err) {
          const f = classifyFailure(err, 'บันทึก Project Co ไม่สำเร็จ')
          result.coFailed.push({ project: pname, code: f.code, message: f.message })
          afterFailure(step, f, err)
        }
      }
      for (const c of row.co) {
        if ((c.action !== 'add' && c.action !== 'upgrade') || result.stopped) continue
        const verb = c.action === 'upgrade' ? 'ปรับเป็นผู้ดูแลโครงการ' : 'เพิ่มเป็นผู้ดูแลโครงการ'
        const step = begin('manager', `${verb}: ${c.name} → ${pname}`)
        const skip = (msg) => {
          result.managerSkipped.push({ project: pname, name: c.name, message: msg })
          end(step, 'skip', msg)
        }
        if (failedEmail.has(c.email)) {
          skip('ข้าม — สร้างบัญชีไม่สำเร็จ')
          continue
        }
        if (noMember.has(c.email)) {
          skip(`ข้าม — ${noMember.get(c.email)}`)
          continue
        }
        const userId = idByEmail.get(c.email)
        if (!userId) {
          skip('ข้าม — ไม่พบรหัสผู้ใช้')
          continue
        }
        try {
          await deps.setManager(row.projectId, userId)
          result.managerOk.push({ project: pname, name: c.name, action: c.action })
          soft = 0
          end(step, 'ok')
        } catch (err) {
          const f = classifyFailure(err, 'บันทึกสิทธิ์ไม่สำเร็จ')
          result.managerFailed.push({ project: pname, name: c.name, code: f.code, message: f.message })
          afterFailure(step, f, err)
        }
      }
    }
  }
}
