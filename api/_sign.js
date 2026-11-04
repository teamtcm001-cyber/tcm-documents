// HMAC signing for short-lived /api/drive-file URLs.
// Filename starts with "_" so Vercel does not turn it into a route.
// Requires env DRIVE_URL_SECRET (>= 32 random chars). Never logs the secret.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConfigError } from './_auth.js'

export const URL_TTL_SECONDS = 300
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{5,200}$/
const CTRL = /[\u0000-\u001F\u007F]/g

export function getUrlSecret() {
  const s = process.env.DRIVE_URL_SECRET
  if (typeof s !== 'string' || s.length < 32) {
    // The client message stays generic (no env names); sendError logs the NAME server-side.
    console.error('config: DRIVE_URL_SECRET must be set and at least 32 characters')
    throw new ConfigError(['DRIVE_URL_SECRET'])
  }
  return s
}

export function cleanName(name) {
  if (typeof name !== 'string') return ''
  return name.replace(CTRL, '').trim().slice(0, 200)
}

function canonical({ fileId, exp, download, name }) {
  return ['v1', fileId, String(exp), download ? '1' : '0', name || ''].join('\n')
}

export function sign(fields, secret = getUrlSecret()) {
  return createHmac('sha256', secret).update(canonical(fields)).digest('base64url')
}

export function verify(fields, sig, secret = getUrlSecret()) {
  if (typeof sig !== 'string' || sig.length < 20 || sig.length > 100) return false
  const want = Buffer.from(sign(fields, secret))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got)
}

// Builds a relative signed URL for a Drive file id.
export function buildSignedUrl({ fileId, download = false, name = '' }, now = Date.now()) {
  const exp = Math.floor(now / 1000) + URL_TTL_SECONDS
  const nm = cleanName(name)
  const sig = sign({ fileId, exp, download, name: nm })
  const p = new URLSearchParams({ fileId, exp: String(exp) })
  if (download) p.set('download', '1')
  if (nm) p.set('name', nm)
  p.set('sig', sig)
  return { url: `/api/drive-file?${p.toString()}`, expiresAt: new Date(exp * 1000).toISOString() }
}
