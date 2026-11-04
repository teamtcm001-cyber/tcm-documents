import { createClient } from '@supabase/supabase-js';
import { uploadToDrive, discardDriveUpload, clearDriveTokenCache } from '../utils/googleDrive.js';
import {
  todayTH, isIsoDate, isSaneDate, INSANE_DATE_MESSAGE, ALL_STATUSES, CLEARS_BILLED_DATE,
  phoneError, normalizePhones, PROJECT_STATUSES,
} from '../utils/tracking.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Missing Supabase credentials. Check .env file');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  // Sessions live in localStorage and refresh themselves. No magic links / OAuth are used,
  // so the URL is never inspected for a session.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ============ AUTH ============
// Real per-person login (email + password). Accounts are created by an admin
// (POST /api/admin-users); there is no self sign-up and no e-mail based recovery:
// an admin resets the password. The database decides what a signed-in person may
// see/do (RLS, scripts/auth-01-foundation.sql + auth-02-enforce-rls.sql); the UI only
// mirrors that for clarity.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72; // bcrypt limit used by Supabase Auth

// Error with a Thai, user-safe message. `code` is a stable machine value.
export class AppError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'AppError';
    this.code = code || 'error';
    if (extra) Object.assign(this, extra);
  }
}

const isNetworkError = (error) =>
  !error ||
  error.name === 'AuthRetryableFetchError' ||
  error.status === 0 ||
  /failed to fetch|networkerror|load failed|network request failed/i.test(error.message || '');

function describeAuthError(error, fallback) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  if (code === 'user_banned' || /banned/i.test(msg)) {
    return new AppError('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'account_disabled');
  }
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) {
    return new AppError('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'invalid_credentials');
  }
  if (code === 'email_not_confirmed') {
    return new AppError('บัญชียังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 'account_disabled');
  }
  if (code === 'over_request_rate_limit' || error?.status === 429) {
    return new AppError('พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'rate_limited');
  }
  // same_password must be tested first: its message ("New password should be different ...") also starts with "password should"
  if (code === 'same_password' || /different from the old password/i.test(msg)) {
    return new AppError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม', 'same_password');
  }
  if (code === 'weak_password' || /password should (be at least|contain)|weak/i.test(msg)) {
    return new AppError(`รหัสผ่านไม่ปลอดภัยพอ — ใช้อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร ผสมตัวอักษรและตัวเลข`, 'weak_password');
  }
  if (code === 'reauthentication_needed' || /reauthenticat/i.test(msg)) {
    return new AppError('เพื่อความปลอดภัย กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ก่อนเปลี่ยนรหัสผ่าน', 'reauthentication_needed');
  }
  if (isNetworkError(error)) {
    return new AppError('เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', 'network');
  }
  return new AppError(fallback || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'error');
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  if (error) throw describeAuthError(error, 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
  clearDriveTokenCache();
  return data;
}

// 'local' = end THIS browser's session only (the default would sign the person out everywhere).
export async function signOut() {
  clearDriveTokenCache();
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    console.warn('signOut failed:', err?.message);
  }
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw describeAuthError(error);
  return data?.session || null;
}

// cb(event, session). Returns an unsubscribe function.
export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data?.subscription?.unsubscribe();
}

export async function getCurrentUser() {
  const session = await getSession();
  if (!session?.user) throw new AppError('กรุณาเข้าสู่ระบบ', 'unauthorized');
  return session.user;
}

// The caller's ACTIVE profile { id, email, full_name, role, active, must_change_password }
// or null when there is none (deactivated person / no profile). Network or server
// failures THROW, so "disabled" is never confused with "could not check".
export async function fetchMyProfile() {
  const { data, error } = await supabase.rpc('my_profile');
  if (error) {
    if (error.status === 401 || /jwt/i.test(error.message || '')) throw new AppError('เซสชันหมดอายุ', 'unauthorized');
    throw describeAuthError(error, 'โหลดข้อมูลบัญชีไม่สำเร็จ');
  }
  // composite-returning function: SQL NULL arrives as null or as an all-null object
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id || row.active === false) return null;
  return {
    id: row.id,
    email: row.email || '',
    full_name: row.full_name || '',
    role: row.role,
    active: true,
    must_change_password: row.must_change_password === true,
  };
}

export function validateNewPassword(pw, confirm, { email } = {}) {
  if (!pw) return 'กรุณากรอกรหัสผ่านใหม่';
  if (pw.length < MIN_PASSWORD_LENGTH) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
  if (new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) return `รหัสผ่านยาวเกินไป (ไม่เกิน ${MAX_PASSWORD_BYTES} ไบต์)`;
  if (/^\s|\s$/.test(pw)) return 'รหัสผ่านต้องไม่ขึ้นต้นหรือลงท้ายด้วยช่องว่าง';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return 'รหัสผ่านต้องไม่เหมือนอีเมล';
  if (confirm !== undefined && pw !== confirm) return 'รหัสผ่านทั้งสองช่องไม่ตรงกัน';
  return '';
}

// Step 1 of a password change (Supabase Auth). Step 2 is clearMustChangePassword().
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw describeAuthError(error, 'เปลี่ยนรหัสผ่านไม่สำเร็จ');
}

// Clears profiles.must_change_password for the caller (SECURITY DEFINER function, own row only).
export async function clearMustChangePassword() {
  const { error } = await supabase.rpc('clear_must_change_password');
  if (error) {
    // The function RAISES P0001 'PASSWORD_NOT_CHANGED: ...' when Auth's password was not really changed since
    // the reset, and 28000 'NOT_SIGNED_IN' without a valid JWT.
    if (String(error.code || '') === 'P0001' || /PASSWORD_NOT_CHANGED/.test(error.message || '')) {
      throw new AppError('รหัสผ่านยังไม่ถูกเปลี่ยน', 'password_not_changed');
    }
    if (String(error.code || '') === '28000' || /NOT_SIGNED_IN/.test(error.message || '') || error.status === 401) {
      throw new AppError('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'unauthorized');
    }
    throw describeAuthError(error, 'บันทึกสถานะการเปลี่ยนรหัสผ่านไม่สำเร็จ');
  }
}

// ---- authenticated calls to our own serverless functions ----
// Problems that need the whole app to react. Listeners get one of:
//   'expired'    the session is over                        -> login screen
//   'disabled'   403 account_disabled                       -> blocked screen
//   'mustChange' 403 password_change_required               -> re-read the profile (forced change-password screen)
//   'denied'     a write was refused by RLS / matched 0 rows -> re-read memberships so stale edit controls go away
// A transient 503 auth_unavailable is NOT one of them: it never ends the session (see UNAVAILABLE_MESSAGE).
const authProblemListeners = new Set();
export function subscribeAuthProblem(cb) {
  authProblemListeners.add(cb);
  return () => authProblemListeners.delete(cb);
}
function reportAuthProblem(kind) {
  if (kind === 'expired' || kind === 'denied') clearDriveTokenCache();
  authProblemListeners.forEach((cb) => {
    try {
      cb(kind);
    } catch {
      /* a listener must never break the request */
    }
  });
}

export const UNAVAILABLE_MESSAGE = 'ระบบตรวจสอบสิทธิ์ไม่ตอบสนอง ลองใหม่อีกครั้ง';
export const PASSWORD_CHANGE_REQUIRED_MESSAGE = 'ต้องตั้งรหัสผ่านใหม่ของคุณเองก่อน จึงจะใช้งานส่วนนี้ได้';
export const RATE_LIMITED_MESSAGE = 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
export const SESSION_EXPIRED_MESSAGE = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
// Shown when a write was refused (RLS) or matched no row.
export const NO_ACCESS_MESSAGE = 'ไม่มีสิทธิ์ดำเนินการ หรือข้อมูลถูกเปลี่ยนไปแล้ว — กรุณารีเฟรช';

const unavailableError = () => new AppError(UNAVAILABLE_MESSAGE, 'auth_unavailable');

// network trouble or a 5xx from the auth server: the session itself may still be fine
const isTransientAuthError = (error) =>
  isNetworkError(error) || (typeof error?.status === 'number' && error.status >= 500);

// -> { token } | { token: null, transient: true } (auth server unreachable: keep the session) | { token: null }
async function getAccessToken({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) return isTransientAuthError(error) ? { token: null, transient: true } : { token: null };
    return { token: data?.session?.access_token || null };
  }
  const { data, error } = await supabase.auth.getSession(); // refreshes an expired token itself
  const session = data?.session;
  if (!session) return error && isTransientAuthError(error) ? { token: null, transient: true } : { token: null };
  // refresh a little early so a request does not race the expiry
  if (session.expires_at && session.expires_at - Date.now() / 1000 < 30) {
    const { data: r, error: rErr } = await supabase.auth.refreshSession();
    if (rErr) return isTransientAuthError(rErr) ? { token: session.access_token } : { token: null };
    return { token: r?.session?.access_token || session.access_token };
  }
  return { token: session.access_token };
}

// fetch() + "Authorization: Bearer <access token>". Returns the Response untouched so each caller keeps
// its own handling, but:
//   * 401 -> refresh the token once and retry; still 401 -> the session is over (reported as 'expired')
//     and the response is returned;
//   * 403 { error: 'account_disabled' } -> reported as 'disabled';
//   * 403 { error: 'password_change_required' } -> reported as 'mustChange' (forced password screen);
//   * 503 (auth_unavailable) -> returned as is and the session is KEPT; use apiErrorMessage() for the text.
// If the auth server cannot be reached while refreshing, throws AppError(code 'auth_unavailable') instead of
// treating the session as expired. Never logs tokens.
export async function authFetch(url, init = {}) {
  const send = (token) => {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };

  let { token, transient } = await getAccessToken();
  if (!token) {
    if (transient) throw unavailableError();
    reportAuthProblem('expired');
    throw new AppError(SESSION_EXPIRED_MESSAGE, 'unauthorized');
  }
  let res = await send(token);
  if (res.status === 401) {
    ({ token, transient } = await getAccessToken({ forceRefresh: true }));
    if (!token && transient) throw unavailableError();
    if (token) res = await send(token);
    if (!token || res.status === 401) {
      reportAuthProblem('expired');
      return res;
    }
  }
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => null);
    if (body?.error === 'account_disabled') reportAuthProblem('disabled');
    else if (body?.error === 'password_change_required') reportAuthProblem('mustChange');
  }
  return res;
}

// Reads { error, message } from one of our API error responses.
async function readApiError(res) {
  const body = await res.json().catch(() => null);
  return { code: body?.error || `http_${res.status}`, message: typeof body?.message === 'string' ? body.message : '', body };
}

// Thai message for a failed /api/* response. Codes with a fixed client wording win over the server's own
// text; for the rest the server's Thai message is used, then `fallback`.
export function apiErrorMessage(status, code, serverMessage, fallback) {
  switch (code) {
    case 'auth_unavailable': return UNAVAILABLE_MESSAGE;
    case 'password_change_required': return PASSWORD_CHANGE_REQUIRED_MESSAGE;
    case 'rate_limited': return RATE_LIMITED_MESSAGE;
    case 'cannot_remove_last_admin':
    case 'last_admin': // old name, kept for safety
      return 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน';
    case 'pw_marker_failed': return serverMessage || 'ดำเนินการไม่สมบูรณ์ — กรุณาลองอีกครั้ง';
    case 'audit_unavailable': return serverMessage || 'ระบบบันทึกประวัติไม่พร้อมใช้งาน ยังไม่ได้ดำเนินการ — กรุณาลองอีกครั้ง';
    default: break;
  }
  if (status === 503) return UNAVAILABLE_MESSAGE;
  if (status === 429) return RATE_LIMITED_MESSAGE;
  return serverMessage || fallback;
}

// ---- writes: map database errors to Thai, tell the app when access / session is stale ----
// RLS refusing a write is either a 42501 error or "0 rows affected" (UPDATE/DELETE silently filtered).
// Both mean the person's idea of what they may do is out of date -> 'denied' (AuthContext re-reads memberships).
const isJwtError = (error) => String(error?.code || '') === 'PGRST301' || /\bJWT\b/.test(error?.message || '');
const isRlsError = (error) =>
  String(error?.code || '') === '42501' || /row-level security|permission denied/i.test(error?.message || '');

// What to throw for a failed write: AppError for session / permission problems, else the error itself.
function writeError(error) {
  if (isJwtError(error)) {
    reportAuthProblem('expired');
    return new AppError(SESSION_EXPIRED_MESSAGE, 'unauthorized');
  }
  if (isRlsError(error)) {
    reportAuthProblem('denied');
    return new AppError(NO_ACCESS_MESSAGE, 'no_access');
  }
  return error;
}
// An UPDATE/DELETE that RLS filters out succeeds with 0 rows: surface that. Returns the affected rows.
function requireAffected(data) {
  if (!data || data.length === 0) {
    reportAuthProblem('denied');
    throw new AppError(NO_ACCESS_MESSAGE, 'no_access');
  }
  return data;
}

// ---- project membership (who may see / edit which project) ----
// { [project_id]: 'editor' | 'viewer' } for the signed-in person (own rows; RLS pm_select_own).
// userId is required because an exec (and an admin) can read other people's rows too.
export async function fetchMyMemberships(userId) {
  const { data, error } = await supabase.from('project_members').select('project_id, role').eq('user_id', userId);
  if (error) throw error;
  const out = {};
  for (const r of data || []) out[r.project_id] = r.role;
  return out;
}

// ---- admin console data (admin only; RLS + /api/admin-users enforce it) ----
export async function fetchAllProjectsForAdmin() {
  const { data, error } = await supabase
    .from('projects')
    .select('id, code, name, status, color')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

// rows of project_members for one user: [{ project_id, role }]
export async function fetchMemberships(userId) {
  const { data, error } = await supabase.from('project_members').select('project_id, role').eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

// role: 'editor' | 'viewer' | null/'none' (= remove access). One row per (project, user).
export async function setMembership(projectId, userId, role) {
  if (!role || role === 'none') {
    const { error } = await supabase.from('project_members').delete().eq('project_id', projectId).eq('user_id', userId);
    if (error) throw error;
    return null;
  }
  if (!['editor', 'viewer'].includes(role)) throw new AppError('สิทธิ์ไม่ถูกต้อง', 'bad_request');
  const { data, error } = await supabase
    .from('project_members')
    .upsert([{ project_id: projectId, user_id: userId, role }], { onConflict: 'project_id,user_id' })
    .select();
  if (error) throw error;
  if (!data || data.length === 0) throw new AppError('บันทึกสิทธิ์ไม่สำเร็จ (ไม่มีสิทธิ์ดำเนินการ)', 'forbidden');
  return role;
}

// POST /api/admin-users { action, ...payload } -> parsed JSON ({ ok: true, ... }).
// Throws AppError with the server's Thai message and its error code
// (cannot_modify_self, cannot_remove_last_admin, email_exists, invalid_email, forbidden, ...).
async function adminCall(action, payload = {}) {
  let res;
  try {
    res = await authFetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง', 'network');
  }
  if (!res.ok) {
    const { code, message, body: errBody } = await readApiError(res);
    if (res.status === 401) throw new AppError(SESSION_EXPIRED_MESSAGE, 'unauthorized', { status: 401 });
    const fallback =
      res.status === 403 ? 'ไม่มีสิทธิ์ดำเนินการนี้'
        : res.status === 404 ? 'ไม่พบข้อมูล'
          : res.status >= 500 ? 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง'
            : 'ดำเนินการไม่สำเร็จ';
    throw new AppError(apiErrorMessage(res.status, code, message, fallback), code, {
      status: res.status,
      // 409 orphan_auth_user: when the existing sign-in account was last used (ISO string | null)
      ...(code === 'orphan_auth_user' ? { lastSignInAt: errBody?.lastSignInAt ?? null, serverMessage: message } : {}),
    });
  }
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) throw new AppError('ระบบตอบกลับไม่ถูกต้อง', 'bad_response');
  return body;
}

export const adminListUsers = async () => (await adminCall('list')).users || [];
// -> { user, temporaryPassword }  (the password is shown ONCE; never store it)
// A success without a usable temporary password is treated as a failure: the dialog must never show a
// stale / empty password. (Failures such as pw_marker_failed never carry one.)
const withPassword = (body) => {
  if (typeof body.temporaryPassword !== 'string' || body.temporaryPassword.length < 8) {
    throw new AppError('ระบบไม่ได้ส่งรหัสผ่านชั่วคราวกลับมา — กรุณาลองอีกครั้ง', 'bad_response');
  }
  return body;
};
// adoptExisting:true = the admin confirmed taking over an orphan sign-in account (see 409 orphan_auth_user)
export const adminCreateUser = async ({ email, fullName, role, adoptExisting = false }) =>
  withPassword(await adminCall('create', { email, full_name: fullName, role, ...(adoptExisting ? { adoptExisting: true } : {}) }));
// -> { user, temporaryPassword, sessionsRevoked, audit? }
export const adminResetPassword = async (userId) => withPassword(await adminCall('resetPassword', { userId }));
export const adminSetRole = (userId, role) => adminCall('setRole', { userId, role });
export const adminSetActive = (userId, active) => adminCall('setActive', { userId, active });
export const adminUpdateProfile = (userId, fullName) => adminCall('updateProfile', { userId, full_name: fullName });

// ============ PROJECTS ============
export async function fetchProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// projects.project_co_phone is added by scripts/project-tracking-fix-3.sql. Until
// that has been run, any write that includes the column fails with 42703
// (Postgres) / PGRST204 (PostgREST schema cache); both messages name the column.
export const PHONE_COLUMN_MISSING_MESSAGE =
  'บันทึกเบอร์ติดต่อไม่ได้ เพราะฐานข้อมูลยังไม่มีคอลัมน์เบอร์ติดต่อ — ให้ผู้ดูแลรัน scripts/project-tracking-fix-3.sql ใน Supabase SQL Editor ก่อน (ข้อมูลที่แก้ไขยังไม่ถูกบันทึก)';

export function isPhoneColumnMissing(error) {
  if (!error) return false;
  const msg = error.message || '';
  if (/project_co_phone/i.test(msg)) return true;
  return !msg && ['42703', 'PGRST204'].includes(String(error.code || ''));
}

// Returns the created row. If the row was created WITHOUT the phone because the
// column does not exist yet, the returned row carries `_phoneNotSaved: true` so the
// caller can tell the user (creating the project itself never fails for that).
export async function createProject(projectData) {
  const user = await getCurrentUser();
  const insert = (fields) =>
    supabase
      .from('projects')
      .insert([{ ...fields, created_by: user.id }])
      .select();

  const { project_co_phone, ...rest } = projectData || {};
  const phone = normalizePhones(project_co_phone);
  if (!phone) {
    const { data, error } = await insert(rest);
    if (error) throw error;
    return data?.[0];
  }

  const first = await insert({ ...rest, project_co_phone: phone });
  if (!first.error) return first.data?.[0];
  if (!isPhoneColumnMissing(first.error)) throw first.error;
  const retry = await insert(rest);
  if (retry.error) throw retry.error;
  return retry.data?.[0] ? { ...retry.data[0], _phoneNotSaved: true } : retry.data?.[0];
}

// ---- AI chat context: projects + file METADATA in two queries (no per-project loop,
// no extracted text). Extracted text is loaded separately and only used by the
// local content search; it is never sent to the server.
const CHAT_FILE_COLS =
  'id, project_id, type, name, base_name, rev, size, ext, is_latest, storage_path, uploader_name, created_at';

export async function fetchChatIndex() {
  const [pr, fr] = await Promise.all([
    supabase.from('projects').select('*').order('created_at', { ascending: false }),
    supabase.from('files').select(CHAT_FILE_COLS).order('created_at', { ascending: false }).range(0, 4999),
  ]);
  if (pr.error) throw pr.error;
  if (fr.error) throw fr.error;
  return { projects: pr.data || [], files: fr.data || [] };
}

// { [fileId]: extracted text } for files that have any. Never throws (the column
// may not exist on old databases): returns what it managed to read.
// Optional { onError(error) } lets the chat tell "partial map" from "complete map".
export async function fetchFileContents({ onError } = {}) {
  const out = {};
  const PAGE = 50;
  for (let from = 0; from < 5000; from += PAGE) {
    const { data, error } = await supabase
      .from('files')
      .select('id, content_text')
      .not('content_text', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      onError?.(error);
      return out;
    }
    for (const r of data || []) out[r.id] = r.content_text;
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function updateProject(projectId, updates) {
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select(); // full row: callers use it; also proves at least one row was affected
  if (error) throw writeError(error);
  return requireAffected(data)[0];
}

export async function deleteProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .select('id');
  if (error) throw writeError(error);
  requireAffected(data);
}

// ============ FILES ============
export async function fetchFiles(projectId) {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchLatestFiles(limit = 10) {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('is_latest', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Postgres text cannot hold NUL, and PostgREST rejects lone UTF-16 surrogates
// ("unsupported Unicode escape sequence"). PDF text extraction can produce both.
export function sanitizePgText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export async function uploadFile(projectId, file, fileType, uploaderName = null, contentText = null) {
  const user = await getCurrentUser();
  contentText = sanitizePgText(contentText);

  // 1. Upload to Google Drive — storage_path stores the Drive file id.
  // /api/drive-token is per project (role gate for THAT project); a refusal means our idea of the
  // person's access is stale, so the app re-reads memberships.
  let driveFileId;
  try {
    driveFileId = await uploadToDrive(file, authFetch, projectId);
  } catch (err) {
    if (err?.code === 'forbidden') reportAuthProblem('denied');
    throw err;
  }

  // 2. Insert file record (with optional content_text for search)
  const baseName = file.name.replace(/\.\w+$/, '').replace(/_(rev\s*\d+|v\d+|\d{4}-\d{2}-\d{2})$/i, '');
  const ext = file.name.split('.').pop();

  const insertData = {
    project_id: projectId,
    name: file.name,
    type: fileType,
    base_name: baseName,
    size: Math.round(file.size / 1024),
    ext: ext,
    storage_path: driveFileId,
    uploader_id: user.id,
    uploader_name: uploaderName || null,
    is_latest: true
  };
  if (contentText) {
    insertData.content_text = contentText;
  }

  let inserted = await insertFileRow(insertData);
  if (inserted.error && contentText && /content_text/i.test(inserted.error.message || '')) {
    // If content_text column doesn't exist yet, retry without it
    delete insertData.content_text;
    inserted = await insertFileRow(insertData);
  }
  let row = inserted.data?.[0];

  if (inserted.error) {
    // The file is already on Drive. What happens to it depends on what we KNOW about the insert:
    //  * 23505 (storage_path unique): a row already owns this Drive id -> never delete, friendly message;
    //  * unknown outcome (network / timeout / 5xx): the INSERT may have committed -> never delete; look the row up
    //    by storage_path: found = success, not found = tell the person to check before uploading again;
    //  * definite rejection (4xx: RLS / permission, check or not-null violation, JWT): nothing was stored ->
    //    delete the Drive object, but only after re-selecting by storage_path proves no row points at it;
    //  * anything else: keep the object (never guess).
    const err = inserted.error;
    if (String(err.code || '') === '23505') {
      throw new AppError('ไฟล์นี้ถูกบันทึกในระบบแล้ว', 'already_saved');
    }
    if (isUnknownOutcome(inserted)) {
      const found = await findRowByStoragePath(driveFileId);
      if (found.row) {
        row = found.row;
      } else {
        throw new AppError('ไม่แน่ใจว่าบันทึกสำเร็จ — ตรวจสอบรายการเอกสารก่อนอัปโหลดซ้ำ', 'unsure_outcome');
      }
    } else {
      if (isDefiniteRejection(inserted)) {
        const found = await findRowByStoragePath(driveFileId);
        if (!found.error && !found.row) await discardDriveUpload(projectId, driveFileId);
      }
      throw writeError(err);
    }
  }
  if (!row) {
    // insert reported success but returned nothing: it may still exist (e.g. not readable back) -> never delete
    const found = await findRowByStoragePath(driveFileId);
    if (!found.row) {
      reportAuthProblem('denied');
      throw new AppError(NO_ACCESS_MESSAGE, 'no_access');
    }
    row = found.row;
  }

  // 3. Mark old versions as not latest, then make sure exactly one row of the family is. The file IS saved at this
  // point, so a failure here is only a warning (row._warning) - the caller shows it without failing the upload.
  try {
    await settleLatest(projectId, fileType, baseName, row);
  } catch (err) {
    return {
      ...row,
      _warning: err instanceof AppError && err.code === 'latest_unsettled'
        ? err.message
        : 'อัปโหลดแล้ว แต่ตั้งสถานะ "เวอร์ชันล่าสุด" ไม่สำเร็จ — กรุณารีเฟรชหน้า',
    };
  }
  return row;
}

// supabase-js reports a lost connection / timeout as { error, status: 0 }, never as an exception.
const insertFileRow = async (fields) => {
  try {
    return await supabase.from('files').insert([fields]).select();
  } catch (e) {
    return { data: null, status: 0, error: { message: String(e?.message || e), code: '' } };
  }
};
// the request may or may not have been executed
const isUnknownOutcome = (res) => !!res.error && (!res.status || res.status >= 500);
// PostgREST answered 4xx with a reason that proves nothing was stored
const isDefiniteRejection = (res) => {
  const e = res.error;
  if (!e || !(res.status >= 400 && res.status < 500)) return false;
  return isRlsError(e) || isJwtError(e) || ['23514', '23502'].includes(String(e.code || ''));
};
// -> { row } (a files row that references this Drive id | null) or { error } when the lookup itself failed
async function findRowByStoragePath(driveId) {
  try {
    const { data, error } = await supabase.from('files').select('*').eq('storage_path', driveId).limit(1);
    if (error) return { error };
    return { row: data?.[0] || null };
  } catch (error) {
    return { error };
  }
}

// Newest first: created_at, then id as the tie-break (every client computes the same winner).
const newestFirst = (a, b) =>
  (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// A version family is (project_id, type, base_name). Two editors uploading versions at the same moment
// can each flip the other's row and leave NO latest row, so after the normal flip the family is re-read
// and exactly one is_latest (the newest) is enforced, fixing up with further updates (max 3 rounds, then
// one last verification read). A fix-up that matches 0 rows is not an error by itself (someone else may
// have fixed it first): the re-read decides.
async function settleLatest(projectId, type, baseName, newRow) {
  const family = () =>
    supabase.from('files').select('id, is_latest, created_at').eq('project_id', projectId).eq('type', type).eq('base_name', baseName);
  const write = (patch) =>
    supabase.from('files').update(patch).eq('project_id', projectId).eq('type', type).eq('base_name', baseName);

  // 0 rows is normal here (first version of a document), so it is not checked
  const flip = await write({ is_latest: false }).neq('id', newRow.id).select('id');
  if (flip.error) throw writeError(flip.error);

  for (let round = 0; round < 4; round++) {
    const { data, error } = await family();
    if (error) throw writeError(error);
    const rows = [...(data || [])].sort(newestFirst);
    const winner = rows[0];
    if (!winner) break;
    const extras = rows.filter((r) => r.id !== winner.id && r.is_latest).map((r) => r.id);
    if (winner.is_latest && extras.length === 0) return;
    if (round === 3) break; // the 4th read only verifies
    if (extras.length) {
      const r = await write({ is_latest: false }).in('id', extras).select('id');
      if (r.error) throw writeError(r.error);
    }
    if (!winner.is_latest) {
      const r = await write({ is_latest: true }).eq('id', winner.id).select('id');
      if (r.error) throw writeError(r.error);
    }
  }
  reportAuthProblem('denied');
  throw new AppError('อัปโหลดไฟล์แล้ว แต่ตั้งสถานะ "เวอร์ชันล่าสุด" ไม่สำเร็จ — กรุณารีเฟรชหน้า', 'latest_unsettled');
}

// Update content_text for existing file (used for reindexing)
// -> true when saved; false when the content_text column does not exist yet; throws when no row was
// updated (RLS refusal / file deleted meanwhile) or on any other error.
export async function updateFileContent(fileId, contentText) {
  const { data, error } = await supabase
    .from('files')
    .update({ content_text: sanitizePgText(contentText) })
    .eq('id', fileId)
    .select('id');
  if (error) {
    if (/content_text/i.test(error.message || '')) return false;
    throw writeError(error);
  }
  requireAffected(data);
  return true;
}

// ---- file bytes: signed, short-lived URLs ----
// /api/drive-file only serves URLs signed by POST /api/drive-url (valid ~5 minutes), and
// drive-url checks that the signed-in person may see the file row. So every preview /
// download / re-index first asks for a fresh URL, then uses it straight away.
// `fileId` is the files.id (row id), NOT the Drive id in storage_path.
const FILE_URL_ERRORS = {
  404: 'ไม่พบไฟล์นี้ หรือไม่มีสิทธิ์เปิดไฟล์นี้',
  429: 'ขอไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
};

// -> absolute URL string. { download, name } become part of the signature (attachment filename).
export async function getSignedFileUrl(fileId, { download = false, name } = {}) {
  if (fileId === undefined || fileId === null || fileId === '') throw new AppError('ไม่พบไฟล์', 'not_found');
  let res;
  try {
    res = await authFetch('/api/drive-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, ...(download ? { download: true } : {}), ...(name ? { name } : {}) }),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง', 'network');
  }
  if (!res.ok) {
    const { code, message } = await readApiError(res);
    if (res.status === 401) throw new AppError(SESSION_EXPIRED_MESSAGE, 'unauthorized');
    throw new AppError(
      apiErrorMessage(res.status, code, message, FILE_URL_ERRORS[res.status] || 'เปิดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'),
      code
    );
  }
  const body = await res.json().catch(() => null);
  if (!body?.url || typeof body.url !== 'string') throw new AppError('เปิดไฟล์ไม่สำเร็จ', 'bad_response');
  // absolute: the Office Online viewer fetches the file from Microsoft's servers
  return /^https?:\/\//i.test(body.url) ? body.url : `${window.location.origin}${body.url}`;
}

// fetch() the file bytes. A link that expired between minting and use (403 link_expired)
// is re-requested ONCE.
export async function fetchFileResponse(fileId, { download = false, name } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = await getSignedFileUrl(fileId, { download, name });
    const res = await fetch(url);
    if (res.status === 403 && attempt === 0) {
      const body = await res.clone().json().catch(() => null);
      if (body?.error === 'link_expired') continue;
    }
    return res;
  }
}

// Get file blob (for reindexing)
export async function getFileBlob(fileId) {
  const res = await fetchFileResponse(fileId);
  if (!res.ok) throw new Error('ไม่สามารถอ่านไฟล์จาก Google Drive ได้');
  return res.blob();
}

export async function deleteFile(fileId) {
  const { data, error } = await supabase
    .from('files')
    .delete()
    .eq('id', fileId)
    .select('id');
  if (error) throw writeError(error);
  requireAffected(data);
}

export async function downloadFile(fileId, fileName) {
  // Fresh signed URL with the download flag (the server answers with Content-Disposition: attachment)
  const url = await getSignedFileUrl(fileId, { download: true, name: fileName });
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'file';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============ ACTIVITY/TIMELINE ============
export async function fetchActivity(projectId, limit = 6) {
  const { data, error } = await supabase
    .from('activity')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// No display name is stored (user decision): who did what is recorded by the database
// audit trail (admin only). user_id must be the caller's own id (RLS activity_insert).
export async function logActivity(projectId, action, details, fileId = null) {
  const user = await getCurrentUser();
  const { error } = await supabase
    .from('activity')
    .insert([{
      project_id: projectId,
      action,
      details,
      file_id: fileId,
      user_id: user.id,
      user_name: null
    }]);
  if (error) throw error;
}

// ============ STATS ============
export async function fetchStats() {
  const [projectsData, filesData] = await Promise.all([
    supabase.from('projects').select('id', { count: 'exact' }),
    supabase.from('files').select('id', { count: 'exact' })
  ]);

  return {
    projects: projectsData.count || 0,
    files: filesData.count || 0,
    types: 8 // Fixed for now
  };
}

// ============ PROJECT TRACKING ============
// Backed by scripts/project-tracking.sql (the contract). The tables may not be
// installed yet, so:
//   * READ functions never throw. They resolve to
//       { data, notInstalled, error }
//     where notInstalled === true means the tracking schema is missing and the
//     UI should show TRACKING_NOT_INSTALLED_MESSAGE instead of data.
//   * WRITE functions throw an Error whose message is already Thai and safe to
//     toast; err.notInstalled === true when the schema is missing.
// Nothing here is enforced per person: updated_by / attached_by / project_co
// are self-reported display names (see the SECURITY note in the SQL file).

export const TRACKING_NOT_INSTALLED_MESSAGE =
  'ยังไม่ได้ติดตั้งโครงสร้างข้อมูลติดตามงาน — ให้ผู้ดูแลรัน scripts/project-tracking.sql ใน Supabase SQL Editor';

// Postgres: 42P01 undefined_table, 42703 undefined_column, 42883 undefined_function
// PostgREST: PGRST200 (no such relationship), PGRST204 (column not in cache), PGRST205 (table/view not in cache)
export function isTrackingNotInstalled(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (['42P01', '42703', '42883', 'PGRST200', 'PGRST204', 'PGRST205'].includes(code)) return true;
  return /does not exist|could not find the (table|function|relationship|'[^']+' column)|schema cache/i.test(
    error.message || ''
  );
}

async function trackingRead(run) {
  try {
    const { data, error, partial } = await run();
    if (error) return { data: null, notInstalled: isTrackingNotInstalled(error), error };
    return { data, notInstalled: false, error: null, partial: !!partial };
  } catch (error) {
    return { data: null, notInstalled: isTrackingNotInstalled(error), error };
  }
}

// Turn a Supabase/Postgres error into an Error with a Thai message.
function trackingWriteError(error, fallback = 'บันทึกไม่สำเร็จ') {
  if (isTrackingNotInstalled(error)) {
    const e = new Error(TRACKING_NOT_INSTALLED_MESSAGE);
    e.notInstalled = true;
    return e;
  }
  const msg = error?.message || '';
  let text;
  if (error?.code === '23505') {
    text = /unique_label/.test(msg)
      ? 'มีรายการชื่อนี้ในเช็กลิสต์อยู่แล้ว'
      : 'ข้อมูลซ้ำกับที่มีอยู่แล้ว (มีคนอื่นเพิ่มพร้อมกัน ลองใหม่อีกครั้ง)';
  } else if (error?.code === '23514') {
    text = /projects_period_chk/.test(msg)
      ? 'วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มสัญญา'
      : /does not belong to project/.test(msg)
        ? 'ไฟล์นี้ไม่ได้อยู่ในโครงการเดียวกับงวดงานนี้'
        : `${fallback}: ข้อมูลไม่ผ่านเงื่อนไขของระบบ`;
  } else if (error?.code === '42501') {
    text = `${fallback}: ไม่มีสิทธิ์เขียนข้อมูลนี้ (ตรวจสอบว่ารัน scripts/project-tracking.sql ครบแล้ว)`;
  } else {
    text = `${fallback}: ${msg || 'ไม่ทราบสาเหตุ'}`;
  }
  const e = new Error(text);
  e.cause = error;
  return e;
}

// Validate a user-supplied date: real yyyy-mm-dd, and a plausible (Gregorian) year.
function assertDate(v, formatMessage = 'รูปแบบวันที่ไม่ถูกต้อง') {
  if (!isIsoDate(v)) throw new Error(formatMessage);
  if (!isSaneDate(v)) throw new Error(INSANE_DATE_MESSAGE);
}

// Tracking writes deliberately do NOT record who made the change (user decision).
// progress_updates.updated_by is NOT NULL with a non-empty check in the live DB,
// so it gets this placeholder; every other recorder column is simply null.
// The UI treats '-' / '' / null as "no name" and never displays it.
const NO_RECORDER = '-';

// An UPDATE that RLS filters out succeeds with 0 rows. Surface that as an error.
function expectRows(data, message) {
  if (!data || data.length === 0) {
    reportAuthProblem('denied'); // maybe stale permissions: AuthContext re-reads memberships
    throw new Error(message || 'บันทึกไม่สำเร็จ: ไม่มีแถวข้อมูลถูกแก้ไข (อาจไม่มีสิทธิ์ หรือรายการถูกลบไปแล้ว)');
  }
  return data[0];
}

// UPDATE/DELETE on installments (delete) and progress_updates (edit/delete) only
// have RLS policies after scripts/project-tracking-fix-2.sql has been run. Before
// that, Postgres answers 42501 or RLS silently matches 0 rows; both mean the same
// thing to the user: ask the admin to run fix-2.
function fix2Message(verb) {
  return `${verb}ไม่สำเร็จ — ผู้ดูแลต้องรัน scripts/project-tracking-fix-2.sql ใน Supabase SQL Editor ก่อน`;
}
function isPermissionError(error) {
  return String(error?.code || '') === '42501' || /permission denied|row-level security/i.test(error?.message || '');
}
// Run on the { data, error } of a write that needs fix-2. Throws a Thai Error, else returns the first row.
function expectFix2Rows({ data, error }, verb) {
  if (error) {
    if (isPermissionError(error)) throw new Error(fix2Message(verb));
    throw trackingWriteError(error, `${verb}ไม่สำเร็จ`);
  }
  return expectRows(data, `${fix2Message(verb)} (หากรันแล้ว ให้รีเฟรชหน้า — รายการอาจถูกลบไปแล้ว)`);
}

// ---- reads: overview / progress ----

// ONE query to project_tracking_overview for the cross-project view.
// The overview view has no "days in status", which the amber rule
// "ready_to_bill for > 7 days" needs, so a tiny best-effort second query on
// installment_summary adds `ready_to_bill_days` per project (null if none).
// If that second query fails the main data is still returned, but with
// `partial: true` so the UI can warn that the health status may be incomplete
// (the aging rule cannot fire without it).
//
// The view has project_co but not project_co_phone (scripts/project-tracking-fix-3.sql
// adds that column to `projects` only), so phones are merged in from one light
// query on `projects` (fetchProjectContacts, which never throws).
export function fetchTrackingOverview() {
  return trackingRead(async () => {
    const main = await supabase
      .from('project_tracking_overview')
      .select('*')
      .order('project_code', { ascending: true });
    if (main.error) return main;

    const [aging, contacts] = await Promise.all([
      supabase
        .from('installment_summary')
        .select('project_id, days_in_status')
        .eq('status', 'ready_to_bill'),
      fetchProjectContacts(),
    ]);
    const maxDays = {};
    if (aging.error) {
      console.warn('fetchTrackingOverview: aging query failed:', aging.error.message);
    } else {
      for (const r of aging.data || []) {
        const d = r.days_in_status ?? 0;
        if (maxDays[r.project_id] === undefined || d > maxDays[r.project_id]) maxDays[r.project_id] = d;
      }
    }
    return {
      data: (main.data || []).map((r) => ({
        ...r,
        ready_to_bill_days: maxDays[r.project_id] ?? null,
        project_co_phone: contacts[r.project_id]?.project_co_phone ?? null,
      })),
      error: null,
      partial: !!aging.error,
    };
  });
}

// { [project_id]: { project_co, project_co_phone } } straight from `projects`.
// NEVER throws: before fix-3 has been run the column is missing, and a failure
// here must not break the page, so any error resolves to {}.
export async function fetchProjectContacts() {
  try {
    const { data, error } = await supabase.from('projects').select('id, project_co, project_co_phone');
    if (error) {
      if (!isPhoneColumnMissing(error)) console.warn('fetchProjectContacts failed:', error.message);
      return {};
    }
    const out = {};
    for (const r of data || []) out[r.id] = { project_co: r.project_co ?? null, project_co_phone: r.project_co_phone ?? null };
    return out;
  } catch (err) {
    console.warn('fetchProjectContacts failed:', err?.message);
    return {};
  }
}

// Single project's overview row (for the detail header). data = row | null
// Phone is merged in from `projects` (best effort; see fetchTrackingOverview).
export function fetchProjectTrackingRow(projectId) {
  return trackingRead(async () => {
    const res = await supabase.from('project_tracking_overview').select('*').eq('project_id', projectId).maybeSingle();
    if (res.error || !res.data) return res;
    // undefined = "could not read it" (NOT the same as null = "really empty"). The edit form
    // must never treat an unknown phone as empty, or an unrelated save would erase a real number.
    // Exception: a missing column (fix-3 not run yet) means there is nothing stored to lose.
    let phone;
    try {
      const p = await supabase.from('projects').select('project_co_phone').eq('id', projectId).maybeSingle();
      if (!p.error) phone = p.data?.project_co_phone ?? null;
      else if (isPhoneColumnMissing(p.error)) phone = null;
    } catch {
      /* stays undefined = unknown */
    }
    return { ...res, data: { ...res.data, project_co_phone: phone } };
  });
}

// Newest first. Entries can be corrected or deleted (needs scripts/project-tracking-fix-2.sql).
export function fetchProgressHistory(projectId) {
  return trackingRead(() =>
    supabase
      .from('progress_updates')
      .select('*')
      .eq('project_id', projectId)
      .order('as_of', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
  );
}

// { percent: whole number 0-100, asOf: 'yyyy-mm-dd' (default today TH, not in the future), note? }
function validateProgressInput({ percent, asOf, note }) {
  if (percent === '' || percent == null) throw new Error('กรุณากรอก % ความคืบหน้า');
  const n = Number(percent);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('% ความคืบหน้าต้องเป็นจำนวนเต็ม 0–100 (ไม่มีทศนิยม)');
  const today = todayTH();
  const date = asOf || today;
  assertDate(date);
  if (date > today) throw new Error('วันที่ข้อมูลต้องไม่เกินวันนี้');
  return { percent_complete: n, as_of: date, note: (note || '').trim() || null };
}

export async function addProgressUpdate(projectId, input = {}) {
  const fields = validateProgressInput(input);
  const updated_by = NO_RECORDER;
  const { data, error } = await supabase
    .from('progress_updates')
    .insert([{ project_id: projectId, ...fields, updated_by }])
    .select();
  if (error) throw trackingWriteError(error, 'บันทึก % ไม่สำเร็จ');
  return expectRows(data);
}

// Correct an existing entry (same validation as adding). Needs fix-2 (UPDATE policy).
// updated_by is deliberately left untouched: no names are recorded.
export async function updateProgressUpdate(id, input = {}) {
  const fields = validateProgressInput(input);
  const res = await supabase.from('progress_updates').update(fields).eq('id', id).select();
  return expectFix2Rows(res, 'แก้ไขรายการ');
}

// Needs fix-2 (DELETE policy).
export async function deleteProgressUpdate(id) {
  const res = await supabase.from('progress_updates').delete().eq('id', id).select();
  expectFix2Rows(res, 'ลบรายการ');
}

// ---- installments ----

// installment_summary rows for one project, ordered by installment_no
export function fetchInstallments(projectId) {
  return trackingRead(() =>
    supabase
      .from('installment_summary')
      .select('*')
      .eq('project_id', projectId)
      .order('installment_no', { ascending: true })
  );
}

// installment_no = max + 1 (cancelled ones count, the number is never reused).
// The trigger writes the creation event and copies the checklist template.
export async function createInstallment(projectId, { title, plannedBillDate, note } = {}) {
  if (plannedBillDate) assertDate(plannedBillDate);
  const updated_by = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await supabase
      .from('project_installments')
      .select('installment_no')
      .eq('project_id', projectId)
      .order('installment_no', { ascending: false })
      .limit(1);
    if (last.error) throw trackingWriteError(last.error, 'เพิ่มงวดไม่สำเร็จ');
    const installment_no = (last.data?.[0]?.installment_no || 0) + 1;
    const { data, error } = await supabase
      .from('project_installments')
      .insert([{
        project_id: projectId,
        installment_no,
        title: (title || '').trim() || null,
        planned_bill_date: plannedBillDate || null,
        note: (note || '').trim() || null,
        status: 'planned',
        updated_by,
      }])
      .select();
    if (!error) return expectRows(data);
    // two coordinators added at once -> unique(project_id, installment_no); recompute and retry
    if (error.code === '23505' && attempt < 2) continue;
    throw trackingWriteError(error, 'เพิ่มงวดไม่สำเร็จ');
  }
}

// changes: any of { installmentNo, title, plannedBillDate, note }. Does not touch status.
export async function updateInstallment(installmentId, changes = {}) {
  const patch = { updated_by: null };
  if ('installmentNo' in changes) {
    const n = Number(changes.installmentNo);
    if (changes.installmentNo === '' || changes.installmentNo == null || !Number.isInteger(n) || n < 1) {
      throw new Error('งวดที่ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
    }
    patch.installment_no = n;
  }
  if ('title' in changes) patch.title = (changes.title || '').trim() || null;
  if ('note' in changes) patch.note = (changes.note || '').trim() || null;
  if ('plannedBillDate' in changes) {
    if (changes.plannedBillDate) assertDate(changes.plannedBillDate);
    patch.planned_bill_date = changes.plannedBillDate || null;
  }
  const { data, error } = await supabase
    .from('project_installments')
    .update(patch)
    .eq('id', installmentId)
    .select();
  if (error) {
    // unique(project_id, installment_no)
    if (error.code === '23505' && 'installmentNo' in changes) throw new Error(`มีงวดที่ ${changes.installmentNo} อยู่แล้ว`);
    throw trackingWriteError(error, 'แก้ไขงวดไม่สำเร็จ');
  }
  return expectRows(data);
}

// Permanently deletes the installment; its checklist rows go with it (FK cascade).
// The files themselves are not touched. Needs the DELETE policy from fix-2.
export async function deleteInstallment(installmentId) {
  const res = await supabase.from('project_installments').delete().eq('id', installmentId).select();
  expectFix2Rows(res, 'ลบ');
}

// Status + status_note (+ billed_date) in ONE update. Saving the SAME status is
// allowed and simply persists the note / billed date. Any status is allowed (the
// DB does not restrict transitions); the caller confirms backward moves.
// status_note is the installment's persistent "หมายเหตุสถานะ" (there is no
// status history any more). billed_date is not maintained by a trigger, so it is
// set here: the given date (default today) when the status is 'billed', cleared
// for a pre-billing status or cancel, otherwise left as is.
export async function setInstallmentStatus(installmentId, status, note, { billedDate } = {}) {
  if (!ALL_STATUSES.includes(status)) throw new Error('สถานะไม่ถูกต้อง');
  const patch = { status, status_note: (note || '').trim() || null, updated_by: null };
  if (status === 'billed') {
    const today = todayTH();
    const d = billedDate || today;
    assertDate(d, 'รูปแบบวันที่เบิกไม่ถูกต้อง');
    if (d > today) throw new Error('วันที่เบิกต้องไม่เกินวันนี้');
    patch.billed_date = d;
  } else if (CLEARS_BILLED_DATE.includes(status)) {
    patch.billed_date = null;
  }
  const { data, error } = await supabase
    .from('project_installments')
    .update(patch)
    .eq('id', installmentId)
    .select();
  if (error) throw trackingWriteError(error, 'เปลี่ยนสถานะไม่สำเร็จ');
  return expectRows(data);
}

// ---- checklist (installment_documents) ----

// Rows + embedded file (name/ext/version info). file === null when nothing is attached.
// file.is_latest === false means a newer version of that document exists.
export function fetchChecklist(installmentId) {
  return trackingRead(() =>
    supabase
      .from('installment_documents')
      .select('*, file:files(id, project_id, name, ext, type, base_name, size, is_latest, created_at, storage_path)')
      .eq('installment_id', installmentId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
}

export async function addChecklistItem(installmentId, projectId, { label, required = true } = {}) {
  const text = (label || '').trim();
  if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
  const last = await supabase
    .from('installment_documents')
    .select('sort_order')
    .eq('installment_id', installmentId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (last.error) throw trackingWriteError(last.error, 'เพิ่มรายการไม่สำเร็จ');
  const sort_order = (last.data?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await supabase
    .from('installment_documents')
    .insert([{ installment_id: installmentId, project_id: projectId, label: text, required: !!required, sort_order }])
    .select();
  if (error) throw trackingWriteError(error, 'เพิ่มรายการไม่สำเร็จ');
  return expectRows(data);
}

// changes: { required?, label? }
export async function updateChecklistItem(itemId, changes = {}) {
  const patch = {};
  if ('required' in changes) patch.required = !!changes.required;
  if ('label' in changes) {
    const text = (changes.label || '').trim();
    if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
    patch.label = text;
  }
  const { data, error } = await supabase.from('installment_documents').update(patch).eq('id', itemId).select();
  if (error) throw trackingWriteError(error, 'แก้ไขรายการไม่สำเร็จ');
  return expectRows(data);
}

export async function removeChecklistItem(itemId) {
  const { data, error } = await supabase.from('installment_documents').delete().eq('id', itemId).select();
  if (error) throw trackingWriteError(error, 'ลบรายการไม่สำเร็จ');
  expectRows(data, 'ลบไม่สำเร็จ: ไม่พบรายการ หรือไม่มีสิทธิ์ลบ');
}

// file_id + attached_by in ONE update (the trigger checks the file is in the
// same project and stamps attached_at).
export async function attachFileToChecklistItem(itemId, fileId) {
  const attached_by = null;
  const { data, error } = await supabase
    .from('installment_documents')
    .update({ file_id: fileId, attached_by })
    .eq('id', itemId)
    .select();
  if (error) throw trackingWriteError(error, 'แนบไฟล์ไม่สำเร็จ');
  return expectRows(data);
}

export async function detachFileFromChecklistItem(itemId) {
  const { data, error } = await supabase
    .from('installment_documents')
    .update({ file_id: null })
    .eq('id', itemId)
    .select();
  if (error) throw trackingWriteError(error, 'ถอดไฟล์ไม่สำเร็จ');
  return expectRows(data);
}

// Newest version (is_latest = true) of the same family as `file`: project + type + base_name
// (the grouping the drawer shows and settleLatest/uploadFile maintain). data = files row | null.
export function fetchLatestVersionOfFile(file) {
  return trackingRead(() =>
    supabase
      .from('files')
      .select('*')
      .eq('project_id', file.project_id)
      .eq('type', file.type)
      .eq('base_name', file.base_name)
      .eq('is_latest', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

// ---- per-project checklist template (auto-copied into each NEW installment) ----

export function fetchChecklistTemplate(projectId) {
  return trackingRead(() =>
    supabase
      .from('project_checklist_templates')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
}

export async function addChecklistTemplateItem(projectId, { label, required = true } = {}) {
  const text = (label || '').trim();
  if (!text) throw new Error('กรุณากรอกชื่อเอกสาร');
  const last = await supabase
    .from('project_checklist_templates')
    .select('sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (last.error) throw trackingWriteError(last.error, 'เพิ่มรายการแม่แบบไม่สำเร็จ');
  const sort_order = (last.data?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await supabase
    .from('project_checklist_templates')
    .insert([{ project_id: projectId, label: text, required: !!required, sort_order }])
    .select();
  if (error) throw trackingWriteError(error, 'เพิ่มรายการแม่แบบไม่สำเร็จ');
  return expectRows(data);
}

export async function removeChecklistTemplateItem(templateItemId) {
  const { data, error } = await supabase
    .from('project_checklist_templates')
    .delete()
    .eq('id', templateItemId)
    .select();
  if (error) throw trackingWriteError(error, 'ลบรายการแม่แบบไม่สำเร็จ');
  expectRows(data, 'ลบไม่สำเร็จ: ไม่พบรายการ หรือไม่มีสิทธิ์ลบ');
}

// For installments created before the template existed: copy template rows
// whose label is not already on the installment. Returns how many were added.
export async function applyChecklistTemplate(installmentId, projectId) {
  const tpl = await supabase
    .from('project_checklist_templates')
    .select('label, required, sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (tpl.error) throw trackingWriteError(tpl.error, 'ใช้แม่แบบไม่สำเร็จ');
  const existing = await supabase.from('installment_documents').select('label, sort_order').eq('installment_id', installmentId);
  if (existing.error) throw trackingWriteError(existing.error, 'ใช้แม่แบบไม่สำเร็จ');
  const have = new Set((existing.data || []).map((r) => r.label));
  let next = Math.max(-1, ...(existing.data || []).map((r) => r.sort_order ?? 0)) + 1;
  const rows = (tpl.data || [])
    .filter((t) => !have.has(t.label))
    .map((t) => ({ installment_id: installmentId, project_id: projectId, label: t.label, required: t.required, sort_order: next++ }));
  if (rows.length === 0) return 0;
  const { error } = await supabase.from('installment_documents').insert(rows);
  if (error) throw trackingWriteError(error, 'ใช้แม่แบบไม่สำเร็จ');
  return rows.length;
}

// ---- project: contract period + coordinator ----

const PROJECT_NOT_UPDATED_MESSAGE =
  'บันทึกไม่สำเร็จ: ระบบไม่ได้แก้ไขข้อมูลโครงการ (ตาราง projects อาจยังไม่อนุญาตให้แก้ไข — แจ้งผู้ดูแลตรวจ policy UPDATE)';

// '' / null / undefined and anything outside the list are rejected. A project whose
// stored status is some legacy text is never sent through here unless the user picks
// one of the allowed values.
function assertProjectStatus(status) {
  if (!PROJECT_STATUSES.includes(status)) throw new Error('สถานะโครงการไม่ถูกต้อง');
}

// Audit line in the activity log (no names are stored, like the other tracking writes).
// A failure here must never fail the save that already happened.
async function logStatusChange(projectId, from, to) {
  try {
    await logActivity(
      projectId,
      'project_status_change',
      `เปลี่ยนสถานะโครงการ: ${from || '-'} → ${to}`,
      null
    );
  } catch (err) {
    console.warn('logActivity (project_status_change) failed:', err?.message);
  }
}

// Change only projects.status. `previousStatus` (what the user saw) is used for the
// audit line only. Returns the updated row; throws a Thai message on failure.
export async function updateProjectStatus(projectId, status, { previousStatus } = {}) {
  assertProjectStatus(status);
  let row;
  try {
    row = await updateProject(projectId, { status });
  } catch (err) {
    throw trackingWriteError(err, 'เปลี่ยนสถานะโครงการไม่สำเร็จ');
  }
  // RLS filtering the UPDATE leaves 0 rows and no error: do not report that as saved
  if (!row) throw new Error(PROJECT_NOT_UPDATED_MESSAGE);
  await logStatusChange(projectId, previousStatus, status);
  return row;
}

// updates: any subset of { start_date, end_date, project_co, project_co_phone, project_status },
// plus `previous_status` (audit line only). PARTIAL by design: a key that is `undefined` /
// absent is neither validated nor written, so a form that sends only what the user changed
// cannot overwrite what someone else saved meanwhile. '' / null for a provided key clears it
// (status can never be cleared). Validation covers provided fields only; the date-order check
// reads the stored counterpart when just one of the two dates is provided (best effort: the DB
// constraint projects_period_chk is the backstop).
// Reuses updateProject, then verifies a row actually came back: without an UPDATE policy
// on `projects` the call "succeeds" with 0 rows, which would otherwise look like a save.
//
// project_co_phone needs scripts/project-tracking-fix-3.sql. If the column is
// missing the whole save is rejected with a Thai message (nothing is half-saved),
// EXCEPT when the phone is being cleared: there is nothing to store or clear, so the other
// fields are saved without it (keeps editing dates / Project Co usable before fix-3).
// The phone number is never written to the activity log.
export async function updateProjectTracking(projectId, updates = {}) {
  const has = (k) => updates[k] !== undefined;
  const payload = {};

  if (has('start_date')) {
    const v = updates.start_date || null;
    if (v) assertDate(v, 'รูปแบบวันเริ่มสัญญาไม่ถูกต้อง');
    payload.start_date = v;
  }
  if (has('end_date')) {
    const v = updates.end_date || null;
    if (v) assertDate(v, 'รูปแบบวันสิ้นสุดสัญญาไม่ถูกต้อง');
    payload.end_date = v;
  }
  if (has('project_co')) payload.project_co = (updates.project_co || '').trim() || null;
  if (has('project_co_phone')) {
    const phoneMsg = phoneError(updates.project_co_phone);
    if (phoneMsg) throw new Error(phoneMsg);
    payload.project_co_phone = normalizePhones(updates.project_co_phone);
  }
  if (has('project_status')) {
    assertProjectStatus(updates.project_status);
    payload.status = updates.project_status;
  }
  if (Object.keys(payload).length === 0) throw new Error('ไม่มีข้อมูลที่ต้องบันทึก');

  // date order, using the stored value for a counterpart that is not being written
  if ('start_date' in payload || 'end_date' in payload) {
    let s = payload.start_date;
    let e = payload.end_date;
    const onlyOne = !('start_date' in payload && 'end_date' in payload);
    if (onlyOne && (s || e)) {
      try {
        const cur = await supabase.from('projects').select('start_date, end_date').eq('id', projectId).maybeSingle();
        if (!cur.error && cur.data) {
          if (!('start_date' in payload)) s = (cur.data.start_date || '').slice(0, 10) || null;
          if (!('end_date' in payload)) e = (cur.data.end_date || '').slice(0, 10) || null;
        }
      } catch {
        /* the database CHECK constraint still protects the period */
      }
    }
    if (s && e && e < s) throw new Error('วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มสัญญา');
  }

  let row;
  try {
    try {
      row = await updateProject(projectId, payload);
    } catch (err) {
      if (!('project_co_phone' in payload) || !isPhoneColumnMissing(err)) throw err;
      if (payload.project_co_phone) throw new Error(PHONE_COLUMN_MISSING_MESSAGE);
      const { project_co_phone: _omit, ...rest } = payload;
      if (Object.keys(rest).length === 0) throw new Error(PHONE_COLUMN_MISSING_MESSAGE);
      row = await updateProject(projectId, rest);
    }
  } catch (err) {
    if (err?.message === PHONE_COLUMN_MISSING_MESSAGE) throw err;
    throw trackingWriteError(err, 'บันทึกข้อมูลโครงการไม่สำเร็จ');
  }
  if (!row) throw new Error(PROJECT_NOT_UPDATED_MESSAGE);

  // audit trail in the existing activity log; failure here must not fail the save
  const parts = [];
  if ('project_co' in payload) parts.push(`Project Co=${payload.project_co || '-'}`);
  if ('start_date' in payload && 'end_date' in payload) {
    parts.push(`สัญญา ${payload.start_date || '-'} ถึง ${payload.end_date || '-'}`);
  } else {
    if ('start_date' in payload) parts.push(`วันเริ่มสัญญา ${payload.start_date || '-'}`);
    if ('end_date' in payload) parts.push(`วันสิ้นสุดสัญญา ${payload.end_date || '-'}`);
  }
  if ('project_co_phone' in payload) parts.push('แก้ไขเบอร์ติดต่อ'); // never the number itself
  if (parts.length > 0) {
    try {
      await logActivity(projectId, 'tracking_update', `แก้ไขข้อมูลติดตามงาน: ${parts.join(', ')}`);
    } catch (err) {
      console.warn('logActivity (tracking_update) failed:', err?.message);
    }
  }
  if ('status' in payload && payload.status !== updates.previous_status) {
    await logStatusChange(projectId, updates.previous_status, payload.status);
  }
  return row;
}
