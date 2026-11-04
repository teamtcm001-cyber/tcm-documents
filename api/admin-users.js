// Vercel Serverless Function — user administration (admin only).
// Uses the Supabase SERVICE ROLE key (server side only) with the Auth Admin REST API
// and PostgREST. Same-origin only: no Access-Control-Allow-Origin header is set.
//
// Endpoint: POST /api/admin-users   (Authorization: Bearer <admin's supabase access token>)
// Body: { action, ... }   actions: list | create | resetPassword | setRole | setActive | updateProfile
// Env:  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Database contract (scripts by the database-architect; all called with the SERVICE key):
//   rpc/begin_password_reset(p_user uuid) -> boolean  first step of a reset: must_change_password=true
//                                         plus a sentinel marker that clear_must_change_password refuses.
//   rpc/set_pw_marker(p_user uuid) -> boolean   LAST step (after the password was written): marker =
//                                         fingerprint of the new hash, so the forced change is verifiable.
//   rpc/revoke_user_sessions(p_user uuid) -> int  end every live session / refresh token of a user.
//   A trigger on public.profiles refuses any change that would leave zero active admins; its
//   error (errcode 23514, message starts "LAST_ADMIN:") is mapped to 409 cannot_remove_last_admin.
// Reset order: audit(initiated) -> begin_password_reset -> write password -> revoke sessions -> set_pw_marker.
// Audit policy: EVERY mutating action is fail-closed. The audit row is written first (create:
// last, because the id is unknown beforehand, and the new account is rolled back if it fails);
// no audit row => no action (503 audit_unavailable). A failed later step adds `<action>_failed`.
// create + adoptExisting: if an auth user with that e-mail exists but has NO profile, the answer is
// 409 { error:'orphan_auth_user', lastSignInAt } and nothing is changed. Resending the same body with
// adoptExisting:true gives that SAME auth user (id kept, so uploader_id/created_by stay valid) a new
// temporary password and a profile. An existing auth user is never deleted.
//
// Temporary passwords are returned ONCE in the response of create / resetPassword and are
// never logged or stored (only Supabase Auth keeps its hash).
import { randomInt } from 'node:crypto'
import {
  ApiError,
  getSupabaseEnv,
  readJsonBody,
  requireEnv,
  requireUser,
  ROLES,
  sendError,
  UUID_RE,
} from './_auth.js'

const CTRL = /[\u0000-\u001F\u007F]/g
const FETCH_TIMEOUT_MS = 15000
const PROFILE_FIELDS = 'id,email,full_name,role,active,must_change_password,created_at,created_by'

// ---------------------------------------------------------------------------
// service-role HTTP helper (never exported; the key never leaves this module)
// ---------------------------------------------------------------------------
function makeSvc() {
  const { url } = getSupabaseEnv()
  const { SUPABASE_SERVICE_ROLE_KEY: key } = requireEnv(['SUPABASE_SERVICE_ROLE_KEY'])
  return async function svc(path, init = {}) {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    }
    let res
    try {
      res = await fetch(`${url}${path}`, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      throw new ApiError(502, 'upstream_error')
    }
    const text = await res.text().catch(() => '')
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return { ok: res.ok, status: res.status, data }
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
function vEmail(v) {
  if (typeof v !== 'string') throw new ApiError(400, 'invalid_email', 'กรุณากรอกอีเมลให้ถูกต้อง')
  const e = v.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (
    e.length > 254 ||
    at < 1 ||
    at > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e) ||
    e.includes('..') ||
    e.startsWith('.') ||
    e.slice(0, at).endsWith('.')
  ) {
    throw new ApiError(400, 'invalid_email', 'รูปแบบอีเมลไม่ถูกต้อง')
  }
  return e
}

function vRole(v) {
  if (typeof v !== 'string' || !ROLES.includes(v)) {
    throw new ApiError(400, 'invalid_role', 'บทบาทต้องเป็น admin, exec หรือ user')
  }
  return v
}

function vName(v, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, 'invalid_input', 'กรุณากรอกชื่อ')
    return ''
  }
  if (typeof v !== 'string') throw new ApiError(400, 'invalid_input', 'ชื่อไม่ถูกต้อง')
  const n = v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim()
  if (n.length > 120) throw new ApiError(400, 'invalid_input', 'ชื่อยาวเกินไป (สูงสุด 120 ตัวอักษร)')
  if (required && !n) throw new ApiError(400, 'invalid_input', 'กรุณากรอกชื่อ')
  return n
}

function vUserId(v) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ApiError(400, 'invalid_input', 'userId ไม่ถูกต้อง')
  return v.toLowerCase()
}

// ---------------------------------------------------------------------------
// temporary password: 16 chars (+3 hyphens), no look-alike characters
// ---------------------------------------------------------------------------
const UP = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOW = 'abcdefghijkmnpqrstuvwxyz'
const DIG = '23456789'
export function generateTemporaryPassword() {
  const all = UP + LOW + DIG
  const chars = [UP[randomInt(UP.length)], LOW[randomInt(LOW.length)], DIG[randomInt(DIG.length)]]
  while (chars.length < 16) chars.push(all[randomInt(all.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  const s = chars.join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`
}

// ---------------------------------------------------------------------------
// shared operations
// ---------------------------------------------------------------------------
const pickProfile = (p) => ({
  id: p.id,
  email: p.email,
  full_name: p.full_name || '',
  role: p.role,
  active: p.active === true,
  must_change_password: p.must_change_password === true,
  created_at: p.created_at || null,
  created_by: p.created_by || null,
})

async function getProfile(svc, id) {
  const r = await svc(`/rest/v1/profiles?id=eq.${id}&select=${PROFILE_FIELDS}&limit=1`)
  if (!r.ok) throw new ApiError(502, 'upstream_error')
  const p = Array.isArray(r.data) ? r.data[0] : null
  if (!p) throw new ApiError(404, 'user_not_found', 'ไม่พบผู้ใช้')
  return p
}

async function patchProfile(svc, id, patch) {
  const r = await svc(`/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  if (isLastAdminTrigger(r)) throw lastAdminError()
  if (!r.ok) throw new ApiError(502, 'upstream_error')
  const p = Array.isArray(r.data) ? r.data[0] : null
  if (!p) throw new ApiError(404, 'user_not_found', 'ไม่พบผู้ใช้')
  return p
}

async function otherActiveAdmins(svc, excludeId) {
  const r = await svc(
    `/rest/v1/profiles?role=eq.admin&active=eq.true&id=neq.${excludeId}&select=id&limit=2`
  )
  if (!r.ok) throw new ApiError(502, 'upstream_error')
  return Array.isArray(r.data) ? r.data.length : 0
}

const auditUnavailable = () =>
  new ApiError(503, 'audit_unavailable', 'ไม่สามารถบันทึกประวัติการใช้งาน (audit) ได้ จึงไม่ได้ดำเนินการ กรุณาลองใหม่')

async function audit(svc, admin, action, targetId, details) {
  try {
    const r = await svc('/rest/v1/audit_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: admin.id,
        user_email: admin.email,
        action,
        table_name: 'profiles',
        row_id: targetId,
        details,
      }),
    })
    if (!r.ok) console.error('admin-users: audit insert failed, status', r.status)
    return r.ok
  } catch {
    console.error('admin-users: audit insert failed')
    return false
  }
}

// End every session / refresh token of a user via the DB function (the GoTrue admin REST API
// has no stable "sign out user by id" call). True only when the call succeeded.
async function revokeSessions(svc, userId) {
  try {
    const r = await svc('/rest/v1/rpc/revoke_user_sessions', { method: 'POST', body: JSON.stringify({ p_user: userId }) })
    if (!r.ok) console.error('admin-users: revoke_user_sessions failed, status', r.status)
    return r.ok
  } catch {
    return false
  }
}

// Must be called AFTER the password was set. Without the marker the forced password change
// cannot be verified, so callers treat a failure as a failure of the whole operation.
async function setPwMarker(svc, userId) {
  try {
    const r = await svc('/rest/v1/rpc/set_pw_marker', { method: 'POST', body: JSON.stringify({ p_user: userId }) })
    // The DB function returns boolean: true = a profile row was marked. false (no such
    // profile) is a failure too, otherwise the forced change could not be verified.
    const done = r.ok && r.data === true
    if (!done) console.error('admin-users: set_pw_marker failed, status', r.status)
    return done
  } catch {
    return false
  }
}

// First step of a reset: sets must_change_password=true and a sentinel marker that
// clear_must_change_password() always refuses, so the person cannot clear the flag while the
// reset is in flight. Returns true only when the DB function answered `true`.
async function beginPasswordReset(svc, userId) {
  try {
    const r = await svc('/rest/v1/rpc/begin_password_reset', { method: 'POST', body: JSON.stringify({ p_user: userId }) })
    const done = r.ok && r.data === true
    if (!done) console.error('admin-users: begin_password_reset failed, status', r.status)
    return done
  } catch {
    return false
  }
}

// Map the DB trigger's refusal to a Thai 409. tg_profiles_last_admin raises errcode 23514
// (PostgREST: HTTP 400) with a message that starts "LAST_ADMIN:". Nothing looser is accepted,
// so an unrelated check violation is never reported as "last admin".
const lastAdminError = () =>
  new ApiError(409, 'cannot_remove_last_admin', 'ต้องมีผู้ดูแลระบบ (admin) ที่ใช้งานอยู่อย่างน้อย 1 คน')
function isLastAdminTrigger(r) {
  if (!r || r.ok || (r.status !== 400 && r.status !== 409)) return false
  const d = r.data
  return !!d && typeof d === 'object' && d.code === '23514' && typeof d.message === 'string' && d.message.includes('LAST_ADMIN')
}

async function setAuthPassword(svc, userId, password) {
  const r = await svc(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) })
  if (!r.ok) throw new ApiError(502, 'upstream_error', 'ไม่สามารถตั้งรหัสผ่านได้')
}

async function setAuthBan(svc, userId, banned) {
  const r = await svc(`/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none' }),
  })
  return r.ok
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function actList(svc) {
  const profiles = []
  for (let off = 0; off < 20000; off += 1000) {
    const r = await svc(`/rest/v1/profiles?select=${PROFILE_FIELDS}&order=created_at.asc&limit=1000&offset=${off}`)
    if (!r.ok) throw new ApiError(502, 'upstream_error')
    const rows = Array.isArray(r.data) ? r.data : []
    profiles.push(...rows)
    if (rows.length < 1000) break
  }

  const lastSignIn = {}
  for (let page = 1; page <= 50; page++) {
    const r = await svc(`/auth/v1/admin/users?page=${page}&per_page=200`)
    if (!r.ok) throw new ApiError(502, 'upstream_error')
    const users = Array.isArray(r.data && r.data.users) ? r.data.users : []
    for (const u of users) lastSignIn[u.id] = u.last_sign_in_at || null
    if (users.length < 200) break
  }

  const counts = {}
  for (let off = 0; off < 100000; off += 1000) {
    const r = await svc(`/rest/v1/project_members?select=user_id&order=user_id.asc&limit=1000&offset=${off}`)
    if (!r.ok) throw new ApiError(502, 'upstream_error')
    const rows = Array.isArray(r.data) ? r.data : []
    for (const m of rows) counts[m.user_id] = (counts[m.user_id] || 0) + 1
    if (rows.length < 1000) break
  }

  return {
    users: profiles.map((p) => ({
      ...pickProfile(p),
      last_sign_in_at: lastSignIn[p.id] || null,
      project_count: counts[p.id] || 0,
    })),
  }
}

const isEmailExists = (cr) => {
  const d = cr.data || {}
  return cr.status === 422 && (d.error_code === 'email_exists' || /already|exists|registered/i.test(String(d.msg || d.message || '')))
}

const createAuthUser = (svc, email, password, fullName) =>
  svc('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
  })

// The auth user (GoTrue) that owns this e-mail, or null. Scans the admin list (admin-only path,
// rare: only reached when GoTrue already said "email exists").
async function findAuthUserByEmail(svc, email) {
  for (let page = 1; page <= 50; page++) {
    const r = await svc(`/auth/v1/admin/users?page=${page}&per_page=200`)
    if (!r.ok) throw new ApiError(502, 'upstream_error')
    const users = Array.isArray(r.data && r.data.users) ? r.data.users : []
    const hit = users.find((u) => u && typeof u.email === 'string' && u.email.toLowerCase() === email && UUID_RE.test(String(u.id)))
    if (hit) return hit
    if (users.length < 200) break
  }
  return null
}

async function profileExists(svc, id) {
  const pr = await svc(`/rest/v1/profiles?id=eq.${id}&select=id&limit=1`)
  if (!pr.ok) throw new ApiError(502, 'upstream_error')
  return Array.isArray(pr.data) && pr.data.length > 0
}

// Insert (or complete a trigger-made skeleton of) the profile row. Returns the row or null.
async function upsertProfile(svc, admin, { id, email, fullName, role }) {
  try {
    const pr = await svc('/rest/v1/profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id, email, full_name: fullName, role, active: true, must_change_password: true, created_by: admin.id }),
    })
    if (pr.ok && Array.isArray(pr.data) && pr.data[0]) return pr.data[0]
    console.error('admin-users: profile insert failed, status', pr.status)
  } catch {
    console.error('admin-users: profile insert failed')
  }
  return null
}

// Remove (or at least lock) ONLY the profile row this request created. Never touches auth.users.
async function rollbackProfile(svc, id) {
  try {
    const del = await svc(`/rest/v1/profiles?id=eq.${id}`, { method: 'DELETE' })
    if (del.ok) return true
    const lock = await svc(`/rest/v1/profiles?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) })
    return lock.ok
  } catch {
    return false
  }
}

// Undo a half-created NEW account (we created the auth user in this request): profile, then auth user.
async function rollbackCreate(svc, id) {
  await rollbackProfile(svc, id)
  let authGone = false
  try {
    authGone = (await svc(`/auth/v1/admin/users/${id}`, { method: 'DELETE' })).ok
  } catch {
    authGone = false
  }
  if (!authGone) console.error('admin-users: rollback of auth user failed, id', id)
  return authGone
}

const ORPHAN_MESSAGE =
  'อีเมลนี้มีบัญชีเข้าสู่ระบบเดิมอยู่แล้วแต่ยังไม่มีสิทธิ์ในระบบใหม่ ต้องการนำบัญชีเดิมมาใช้ต่อ (ตั้งรหัสผ่านชั่วคราวใหม่) หรือไม่'

// An auth user with this e-mail exists but has NO profile (e.g. the old shared account or someone
// who signed up under the old whitelist). We never delete it: its id is referenced by
// files.uploader_id / projects.created_by / activity.user_id (ON DELETE SET NULL would erase the
// attribution). With adoptExisting:true the SAME auth user id is given a profile.
async function adoptAuthUser(svc, admin, { id, email, role, fullName, password, previousSignIn }) {
  const details = { target_email: email, role, adopted_existing_auth_user: true, auth_user_id: id, previous_last_sign_in_at: previousSignIn || null }
  // audit FIRST: nothing is touched when it cannot be written
  if (!(await audit(svc, admin, 'admin.create_user', id, { ...details, stage: 'initiated' }))) throw auditUnavailable()
  const failed = async (stage, err) => {
    await audit(svc, admin, 'admin.create_user_failed', id, { ...details, stage })
    throw err
  }

  // 1) new temporary password; lift any ban; set the display name
  const up = await svc(`/auth/v1/admin/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ password, ban_duration: 'none', email_confirm: true, user_metadata: { full_name: fullName } }),
  })
  if (!up.ok) await failed('set_password', new ApiError(502, 'upstream_error', 'ไม่สามารถตั้งรหัสผ่านให้บัญชีเดิมได้ ยังไม่ได้ให้สิทธิ์ใช้งาน'))

  // 2) kill every old session BEFORE the profile exists (a holder of an old session must not be
  //    able to turn the account into a working one). Fail closed.
  if (!(await revokeSessions(svc, id))) {
    await failed('revoke_sessions', new ApiError(502, 'revoke_failed', 'ยกเลิกเซสชันเดิมของบัญชีไม่สำเร็จ ยังไม่ได้ให้สิทธิ์ใช้งาน กรุณาลองใหม่'))
  }

  // 3) profile for the SAME id
  const profile = await upsertProfile(svc, admin, { id, email, fullName, role })
  if (!profile) {
    await failed('profile', new ApiError(502, 'profile_create_failed', 'สร้างโปรไฟล์ผู้ใช้ไม่สำเร็จ บัญชีเข้าสู่ระบบเดิมยังอยู่ครบ (รหัสผ่านเดิมถูกเปลี่ยนแล้ว) กรุณาลองใหม่'))
  }

  // 4) marker (the password was written in step 1)
  if (!(await setPwMarker(svc, id))) {
    await rollbackProfile(svc, id) // only the profile we just created; the auth user stays
    await failed('pw_marker', new ApiError(502, 'pw_marker_failed', 'ตั้งค่าการบังคับเปลี่ยนรหัสผ่านไม่สำเร็จ ยกเลิกการให้สิทธิ์แล้ว (บัญชีเข้าสู่ระบบเดิมยังอยู่) กรุณาลองใหม่'))
  }
  return { user: pickProfile(profile), temporaryPassword: password, audit: true, adopted: true }
}

async function actCreate(svc, admin, body) {
  const email = vEmail(body.email)
  const role = vRole(body.role)
  const fullName = vName(body.full_name) || email.split('@')[0]
  const adopt = body.adoptExisting === true
  const password = generateTemporaryPassword()

  const cr = await createAuthUser(svc, email, password, fullName)
  if (!cr.ok) {
    if (!isEmailExists(cr)) {
      console.error('admin-users: create auth user failed, status', cr.status)
      throw new ApiError(502, 'upstream_error', 'สร้างบัญชีไม่สำเร็จ')
    }
    const existing = await findAuthUserByEmail(svc, email)
    if (!existing || (await profileExists(svc, existing.id))) {
      throw new ApiError(409, 'email_exists', 'อีเมลนี้มีบัญชีอยู่แล้ว')
    }
    const lastSignInAt = existing.last_sign_in_at || null
    if (!adopt) {
      throw new ApiError(409, 'orphan_auth_user', ORPHAN_MESSAGE, { public: { lastSignInAt } })
    }
    return adoptAuthUser(svc, admin, { id: existing.id.toLowerCase(), email, role, fullName, password, previousSignIn: lastSignInAt })
  }
  const newId = cr.data && cr.data.id
  if (typeof newId !== 'string' || !UUID_RE.test(newId)) throw new ApiError(502, 'upstream_error', 'สร้างบัญชีไม่สำเร็จ')

  // From here on any failure rolls the whole NEW account back (fail closed).
  const abort = async (err) => {
    await rollbackCreate(svc, newId)
    throw err
  }

  const profile = await upsertProfile(svc, admin, { id: newId, email, fullName, role })
  if (!profile) {
    await abort(new ApiError(502, 'profile_create_failed', 'สร้างโปรไฟล์ผู้ใช้ไม่สำเร็จ ยกเลิกการสร้างบัญชีแล้ว'))
  }

  // Marker only now: the profile exists and the password was written at creation.
  if (!(await setPwMarker(svc, newId))) {
    await abort(new ApiError(502, 'pw_marker_failed', 'ตั้งค่าการบังคับเปลี่ยนรหัสผ่านไม่สำเร็จ ยกเลิกการสร้างบัญชีแล้ว กรุณาลองใหม่'))
  }

  // Audit is part of the action: no audit row => no account.
  if (!(await audit(svc, admin, 'admin.create_user', newId, { target_email: email, role }))) {
    await abort(auditUnavailable())
  }
  return { user: pickProfile(profile), temporaryPassword: password, audit: true }
}

// Audit-first wrapper for the remaining actions: if the row cannot be written nothing is done
// (503 audit_unavailable); if the action itself fails a best-effort `<action>_failed` row follows.
async function audited(svc, admin, action, targetId, details, fn) {
  if (!(await audit(svc, admin, action, targetId, { ...details, stage: 'initiated' }))) throw auditUnavailable()
  try {
    return await fn()
  } catch (e) {
    await audit(svc, admin, `${action}_failed`, targetId, { ...details, error: e && e.code ? String(e.code) : 'error' })
    throw e
  }
}

async function actResetPassword(svc, admin, body) {
  const id = vUserId(body.userId)
  if (id === admin.id) {
    throw new ApiError(400, 'cannot_modify_self', 'ไม่สามารถรีเซ็ตรหัสผ่านของตัวเองผ่านหน้านี้ได้ กรุณาใช้การเปลี่ยนรหัสผ่านปกติ')
  }
  const target = await getProfile(svc, id)

  // Audit FIRST (a password cannot be un-reset). Nothing changes if it cannot be written.
  if (!(await audit(svc, admin, 'admin.reset_password', id, { target_email: target.email, stage: 'initiated' }))) {
    throw auditUnavailable()
  }
  const failed = async (stage, err) => {
    await audit(svc, admin, 'admin.reset_password_failed', id, { target_email: target.email, stage })
    throw err
  }

  // 1) close the window: must_change_password=true + a sentinel marker that clear_must_change_password
  //    always refuses, BEFORE the password changes. Fail closed.
  if (!(await beginPasswordReset(svc, id))) {
    await failed('begin', new ApiError(502, 'reset_prepare_failed', 'เริ่มการรีเซ็ตรหัสผ่านไม่สำเร็จ ยังไม่ได้เปลี่ยนรหัสผ่าน กรุณาลองใหม่'))
  }
  // 2) write the new temporary password
  const password = generateTemporaryPassword()
  try {
    await setAuthPassword(svc, id, password)
  } catch (e) {
    await failed('set_password', e)
  }
  // 3) end the old sessions
  const sessionsRevoked = await revokeSessions(svc, id)
  // 4) arm the real marker (fingerprint of the NEW hash). Without it the forced change cannot be
  //    verified: no temp password is handed out, the admin must reset again.
  if (!(await setPwMarker(svc, id))) {
    await failed('pw_marker', new ApiError(502, 'pw_marker_failed', 'รีเซ็ตรหัสผ่านไม่สมบูรณ์ (ตั้งค่าการบังคับเปลี่ยนรหัสผ่านไม่สำเร็จ) กรุณากดรีเซ็ตอีกครั้ง'))
  }
  const updated = await getProfile(svc, id)
  return { user: pickProfile(updated), temporaryPassword: password, sessionsRevoked, audit: true }
}

async function actSetRole(svc, admin, body) {
  const id = vUserId(body.userId)
  const role = vRole(body.role)
  if (id === admin.id && role !== 'admin') {
    throw new ApiError(400, 'cannot_modify_self', 'ไม่สามารถเปลี่ยนบทบาทของตัวเองให้ต่ำลงได้')
  }
  const target = await getProfile(svc, id)
  if (target.role === 'admin' && target.active === true && role !== 'admin') {
    if ((await otherActiveAdmins(svc, id)) < 1) throw lastAdminError()
  }
  const updated = await audited(svc, admin, 'admin.set_role', id, { target_email: target.email, from: target.role, to: role }, () =>
    patchProfile(svc, id, { role }) // DB trigger is the race-proof backstop
  )
  return { user: pickProfile(updated), audit: true }
}

async function actSetActive(svc, admin, body) {
  const id = vUserId(body.userId)
  if (typeof body.active !== 'boolean') throw new ApiError(400, 'invalid_input', 'active ต้องเป็น true หรือ false')
  const active = body.active
  if (id === admin.id && !active) {
    throw new ApiError(400, 'cannot_modify_self', 'ไม่สามารถปิดการใช้งานบัญชีของตัวเองได้')
  }
  const target = await getProfile(svc, id)
  if (!active && target.role === 'admin' && target.active === true) {
    if ((await otherActiveAdmins(svc, id)) < 1) throw lastAdminError()
  }

  return audited(svc, admin, 'admin.set_active', id, { target_email: target.email, active }, async () => {
    if (active) {
      // lift the ban first; if that fails nothing has changed
      if (!(await setAuthBan(svc, id, false))) throw new ApiError(502, 'upstream_error', 'ไม่สามารถเปิดการใช้งานบัญชีได้')
      const updated = await patchProfile(svc, id, { active: true })
      return { user: pickProfile(updated), audit: true }
    }
    // profiles.active=false takes effect immediately for every endpoint and RLS check (and is
    // the step the last-admin trigger can refuse); then ban the auth user (blocks sign-in /
    // refresh) and end live sessions through the DB function.
    const updated = await patchProfile(svc, id, { active: false })
    const authBanned = await setAuthBan(svc, id, true)
    const sessionsRevoked = await revokeSessions(svc, id)
    return { user: pickProfile(updated), audit: true, authBanned, sessionsRevoked }
  })
}

async function actUpdateProfile(svc, admin, body) {
  const id = vUserId(body.userId)
  const fullName = vName(body.full_name, { required: true })
  const target = await getProfile(svc, id)
  const updated = await audited(svc, admin, 'admin.update_profile', id, { target_email: target.email }, () =>
    patchProfile(svc, id, { full_name: fullName })
  )
  return { user: pickProfile(updated), audit: true }
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      throw new ApiError(405, 'method_not_allowed')
    }
    // fresh=true: admin calls never use the short auth cache
    const { user, profile } = await requireUser(req, { fresh: true })
    if (profile.role !== 'admin' || profile.active !== true) throw new ApiError(403, 'forbidden', 'เฉพาะผู้ดูแลระบบเท่านั้น')

    const svc = makeSvc()
    const body = readJsonBody(req)
    const admin = { id: user.id, email: user.email }

    let result
    switch (body.action) {
      case 'list':
        result = await actList(svc)
        break
      case 'create':
        result = await actCreate(svc, admin, body)
        break
      case 'resetPassword':
        result = await actResetPassword(svc, admin, body)
        break
      case 'setRole':
        result = await actSetRole(svc, admin, body)
        break
      case 'setActive':
        result = await actSetActive(svc, admin, body)
        break
      case 'updateProfile':
        result = await actUpdateProfile(svc, admin, body)
        break
      default:
        throw new ApiError(400, 'unknown_action', 'ไม่รู้จักคำสั่งนี้')
    }
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    return sendError(res, err)
  }
}
