// Shared auth helper for api/*.js  (filename starts with "_" so Vercel does not
// turn it into a route, same as _drive.js).
//
// Environment variables used by the serverless functions (set in Vercel):
//   SUPABASE_URL               (falls back to VITE_SUPABASE_URL)
//   SUPABASE_ANON_KEY          (falls back to VITE_SUPABASE_ANON_KEY)
//   SUPABASE_SERVICE_ROLE_KEY  admin-users.js ONLY. Never expose to the browser.
//   DRIVE_URL_SECRET           HMAC key for signed file URLs (>= 32 random chars)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN /
//   GOOGLE_DRIVE_FOLDER_ID     Google Drive storage (existing)
//   ANTHROPIC_API_KEY          AI chat (existing, optional)
//   APP_ORIGINS                optional extra browser origins allowed to start uploads (drive-upload-session)
//
// Nothing in here logs tokens, passwords or document content (the only log lines are error
// class names, HTTP status numbers and environment-variable NAMES).
import { createHash } from 'node:crypto'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ROLES = ['admin', 'exec', 'user']

const DEFAULT_MESSAGES = {
  unauthorized: 'กรุณาเข้าสู่ระบบ',
  account_disabled: 'บัญชีนี้ถูกปิดการใช้งาน หรือยังไม่มีสิทธิ์ใช้งาน',
  password_change_required: 'กรุณาเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งานต่อ',
  forbidden: 'ไม่มีสิทธิ์ดำเนินการนี้',
  not_found: 'ไม่พบข้อมูล',
  method_not_allowed: 'ไม่รองรับวิธีการเรียกนี้',
  bad_request: 'ข้อมูลที่ส่งมาไม่ถูกต้อง',
  rate_limited: 'ส่งคำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง',
  server_not_configured: 'ระบบยังตั้งค่าไม่ครบ กรุณาติดต่อผู้ดูแลระบบ',
  auth_unavailable: 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้ กรุณาลองใหม่',
  upstream_error: 'บริการภายนอกไม่ตอบสนอง กรุณาลองใหม่',
  server_error: 'เกิดข้อผิดพลาดภายในระบบ',
}

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || DEFAULT_MESSAGES[code] || code)
    this.status = status
    this.code = code
    this.extra = extra || null
  }
}

export class ConfigError extends ApiError {
  constructor(missing, note) {
    super(500, 'server_not_configured', note || DEFAULT_MESSAGES.server_not_configured, { missing })
  }
}

// Writes a uniform JSON error. Never leaks stack traces, upstream bodies or the NAMES of
// missing environment variables (that would help an unauthenticated caller map the
// deployment). Missing env names are written to the server log only (names, never values).
export function sendError(res, err) {
  if (err instanceof ApiError) {
    const body = { error: err.code, message: err.message }
    if (err.extra && Array.isArray(err.extra.missing) && err.extra.missing.length) {
      console.error('api config error: missing env', err.extra.missing.join(','))
    }
    // `extra.public` = small, non-sensitive fields the client needs (e.g. orphan_auth_user's
    // lastSignInAt). Never put secrets, env names or upstream bodies in here.
    if (err.extra && err.extra.public && typeof err.extra.public === 'object') Object.assign(body, err.extra.public)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(err.status).json(body)
  }
  // Only the error class/name is logged, not the message (could contain data).
  console.error('api unexpected error:', err && err.name ? err.name : 'Error')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(500).json({ error: 'server_error', message: DEFAULT_MESSAGES.server_error })
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function getSupabaseEnv() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '')
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()
  const missing = []
  if (!url) missing.push('SUPABASE_URL')
  if (!anonKey) missing.push('SUPABASE_ANON_KEY')
  if (missing.length) throw new ConfigError(missing)
  return { url, anonKey }
}

// requireEnv(['A','B']) -> { A, B } or throws ConfigError listing NAMES only.
export function requireEnv(names) {
  const out = {}
  const missing = []
  for (const n of names) {
    const v = process.env[n]
    if (typeof v !== 'string' || !v.trim()) missing.push(n)
    else out[n] = v
  }
  if (missing.length) throw new ConfigError(missing)
  return out
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
export function extractBearer(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization)
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/.exec(h.trim())
  return m ? m[1] : null
}

// Vercel normally parses JSON bodies; tolerate string bodies too.
export function readJsonBody(req) {
  let b = req.body
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b)
    } catch {
      throw new ApiError(400, 'bad_request', 'รูปแบบ JSON ไม่ถูกต้อง')
    }
  }
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object' || Array.isArray(b)) {
    throw new ApiError(400, 'bad_request', 'รูปแบบข้อมูลไม่ถูกต้อง')
  }
  return b
}

export function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query
  try {
    return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 10000

async function parseBody(res) {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// PostgREST call made as the USER (RLS applies). Returns { ok, status, data }.
export async function supabaseRest(token, path, init = {}) {
  const { url, anonKey } = getSupabaseEnv()
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  }
  let res
  try {
    res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new ApiError(503, 'auth_unavailable')
  }
  return { ok: res.ok, status: res.status, data: await parseBody(res) }
}

// ---------------------------------------------------------------------------
// requireUser
// ---------------------------------------------------------------------------
// Tiny per-instance cache (15s) keyed by SHA-256 of the token. Revocation of a
// session / deactivation of a profile therefore takes effect within 15s at most
// on a warm instance. Pass { fresh: true } to bypass (admin endpoint does).
const CACHE_TTL_MS = 15000
const CACHE_MAX = 500
const authCache = new Map()
export function _clearAuthCache() {
  authCache.clear()
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex')

export async function requireUser(req, { fresh = false } = {}) {
  const { url, anonKey } = getSupabaseEnv()
  const token = extractBearer(req)
  if (!token) throw new ApiError(401, 'unauthorized')

  const key = hashToken(token)
  if (!fresh) {
    const hit = authCache.get(key)
    if (hit && hit.exp > Date.now()) return hit.value
    if (hit) authCache.delete(key)
  }

  // 1) verify the token with Supabase Auth.
  //    401 ONLY when GoTrue itself says the token is invalid / expired / session gone
  //    (HTTP 401 or 403). Any other failure (429, 400, 404, 5xx, network) is a problem on
  //    OUR side of the wire and must not look like "your session is bad" -> 503.
  let userRes
  try {
    userRes = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new ApiError(503, 'auth_unavailable')
  }
  if (!userRes.ok) {
    if (userRes.status === 401 || userRes.status === 403) {
      const body = await parseBody(userRes)
      const code = body && (body.error_code || body.code)
      if (code === 'user_banned') throw new ApiError(403, 'account_disabled')
      throw new ApiError(401, 'unauthorized')
    }
    throw new ApiError(503, 'auth_unavailable')
  }
  const u = await parseBody(userRes)
  // A 200 whose body is not a user object is a broken upstream, not a bad token.
  if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) throw new ApiError(503, 'auth_unavailable')

  // 2) load the profile with the USER's token (RLS: own row only).
  //    "account_disabled" ONLY when we got a clean answer and the row is absent / inactive /
  //    has an unknown role. A PostgREST error (429, 404 PGRST205 stale schema cache, 5xx...)
  //    is "auth_unavailable". PostgREST 401 means the JWT itself was rejected (PGRST301/303).
  const pr = await supabaseRest(
    token,
    `profiles?id=eq.${u.id}&select=id,email,full_name,role,active,must_change_password`
  )
  if (!pr.ok) {
    const pcode = pr.data && pr.data.code
    if (pr.status === 401 && (pcode === 'PGRST301' || pcode === 'PGRST302' || pcode === 'PGRST303')) {
      throw new ApiError(401, 'unauthorized')
    }
    throw new ApiError(503, 'auth_unavailable')
  }
  if (!Array.isArray(pr.data)) throw new ApiError(503, 'auth_unavailable')
  const profile = pr.data[0] || null
  if (!profile || profile.active !== true || !ROLES.includes(profile.role)) {
    throw new ApiError(403, 'account_disabled')
  }
  // Forced password change is enforced for EVERY endpoint. (The change screen talks to
  // Supabase directly: my_profile / auth.updateUser / clear rpc - never to /api.)
  // Not cached: the entry is only stored below for compliant accounts.
  if (profile.must_change_password === true) throw new ApiError(403, 'password_change_required')

  const value = {
    user: { id: u.id, email: typeof u.email === 'string' ? u.email : profile.email || '' },
    profile: {
      role: profile.role,
      active: true,
      must_change_password: profile.must_change_password === true,
      full_name: profile.full_name || '',
    },
    token,
  }
  if (!fresh) {
    if (authCache.size >= CACHE_MAX) authCache.clear()
    authCache.set(key, { value, exp: Date.now() + CACHE_TTL_MS })
  }
  return value
}

// ---------------------------------------------------------------------------
// Best-effort in-memory rate limit (per warm instance; not a hard guarantee)
// ---------------------------------------------------------------------------
const buckets = new Map()
export function _clearRateLimits() {
  buckets.clear()
}
export function rateLimit(key, max, windowMs) {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || b.reset <= now) {
    if (buckets.size > 5000) buckets.clear()
    b = { count: 0, reset: now + windowMs }
    buckets.set(key, b)
  }
  b.count += 1
  return b.count <= max
}
