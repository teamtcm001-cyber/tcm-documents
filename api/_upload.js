// Shared helpers for api/drive-upload-session.js and api/drive-upload-discard.js.
// Filename starts with "_" so Vercel does not turn it into a route.
//
// Everything that talks to Google from these two endpoints goes through googleFetch():
//   * 15 s AbortSignal.timeout on every call,
//   * redirects are never followed (the bearer token must not follow a 3xx anywhere),
//   * failures surface as ApiError(502, 'upstream_error') with a generic Thai message. Google's
//     response bodies, URLs and tokens are NEVER logged or returned.
import { ApiError, supabaseRest } from './_auth.js'
import { getOAuthClient } from './_drive.js'

export const GOOGLE_TIMEOUT_MS = 15000
const UPSTREAM_MSG = 'ไม่สามารถติดต่อ Google Drive ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'

export const upstreamError = () => new ApiError(502, 'upstream_error', UPSTREAM_MSG)

// Server-held Google access token (from GOOGLE_REFRESH_TOKEN). Never leaves the server.
export async function getServerGoogleToken() {
  let timer
  try {
    const client = getOAuthClient()
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout')), GOOGLE_TIMEOUT_MS)
    })
    const { token } = await Promise.race([client.getAccessToken(), timeout])
    if (typeof token === 'string' && token) return token
  } catch {
    // fall through (nothing from the error is logged: it can echo request details)
  } finally {
    clearTimeout(timer)
  }
  console.error('google token request failed')
  throw upstreamError()
}

// Returns the fetch Response (any HTTP status); throws upstream_error only on network/timeout.
export async function googleFetch(url, init = {}, token) {
  try {
    return await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    })
  } catch {
    console.error('google request failed (network/timeout)')
    throw upstreamError()
  }
}

// The resumable-session URI must be https://www.googleapis.com/upload/drive/v3/files... before it is handed
// to the browser (defence in depth: it is the one URL the browser will PUT file bytes to).
export function safeSessionUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  let u
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'www.googleapis.com' || u.username || u.password || u.port) return null
  if (u.pathname !== '/upload/drive/v3/files') return null
  return u.toString()
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseOrigin(v) {
  if (typeof v !== 'string' || !v || v.length > 300) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return null
    if (u.username || u.password) return null
    return u
  } catch {
    return null
  }
}

// The app origin that Google must allow for CORS on the session URI. Accepted only when
// the browser's Origin is same-origin (host equals the Host header) or listed in the optional
// comma-separated APP_ORIGINS env. Returns the normalised origin string or null.
export function resolveAppOrigin(req) {
  const h = req.headers || {}
  const o = parseOrigin(typeof h.origin === 'string' ? h.origin : '')
  if (!o) return null
  const host = typeof h.host === 'string' ? h.host.trim().toLowerCase() : ''
  if (host && o.host.toLowerCase() === host) return o.origin
  const listed = String(process.env.APP_ORIGINS || '')
    .split(',')
    .map((s) => parseOrigin(s.trim()))
    .filter(Boolean)
    .map((u) => u.origin)
  return listed.includes(o.origin) ? o.origin : null
}

// May this caller EDIT that project? Admin: any project. Role user: only when Postgres says so
// (public.can_edit_project, evaluated with the CALLER's own token so RLS is the single source of
// truth). exec / anything else: never. A failing check is 503 (fail closed), not 403/200.
export async function assertCanEditProject(profile, token, projectId, deniedMessage) {
  if (profile.role === 'admin') return
  if (profile.role !== 'user') throw new ApiError(403, 'forbidden', 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์')
  const r = await supabaseRest(token, 'rpc/can_edit_project', {
    method: 'POST',
    body: JSON.stringify({ p: projectId }),
  })
  if (!r.ok) throw new ApiError(503, 'auth_unavailable')
  if (r.data !== true) throw new ApiError(403, 'forbidden', deniedMessage)
}

// Google-native types (Docs, Sheets, folders, shortcuts...) are never valid for an uploaded file; they would make
// Drive convert it or create a non-file object. Treated like any other invalid mime type.
export const isForbiddenMime = (m) => /^application\/vnd\.google-apps\./i.test(m)
