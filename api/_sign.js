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

// Upload names additionally lose Unicode bidi/format controls (LRM/RLM, embeddings and overrides, isolates, ALM,
// zero-width space/joiners, BOM) so a name cannot be visually spoofed (e.g. "invoice<RLO>fdp.exe"). Truncation is
// by code point, never in the middle of a surrogate pair. cleanName() is left unchanged because the download-URL
// signature covers its exact output.
const FORMAT_CTRL = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g
export function cleanUploadName(name, max = 255) {
  if (typeof name !== 'string') return ''
  return Array.from(name.replace(CTRL, '').replace(FORMAT_CTRL, '').trim()).slice(0, max).join('').trim()
}

// `max` defaults to 200 (display names in signed URLs). drive-upload-session passes 256 so it
// can tell "255 chars" from "too long" instead of silently truncating.
export function cleanName(name, max = 200) {
  if (typeof name !== 'string') return ''
  return name.replace(CTRL, '').trim().slice(0, max)
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

// ---------------------------------------------------------------------------
// Upload tickets (POST /api/drive-upload-session -> POST /api/drive-upload-discard)
// ---------------------------------------------------------------------------
// ticket = base64url(JSON{driveId,userId,projectId,exp}) + '.' + base64url(HMAC-SHA256)
// The HMAC key is NOT the raw DRIVE_URL_SECRET but HMAC(secret, 'upload-ticket'): a distinct
// domain, so a ticket signature can never validate as a file-download signature (or the other
// way round) even if the payload bytes were chosen to look like one. The MAC covers the exact
// base64url text that travels, so there is no canonicalisation to get wrong.
// `exp` is unix SECONDS.
export const TICKET_TTL_SECONDS = 3600
const TICKET_DOMAIN = 'upload-ticket'
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const TICKET_MAX_LEN = 1024

function ticketMac(b64, secret) {
  const key = createHmac('sha256', secret).update(TICKET_DOMAIN).digest()
  return createHmac('sha256', key).update(`${TICKET_DOMAIN}\n${b64}`).digest('base64url')
}

export function signTicket({ driveId, userId, projectId }, now = Date.now(), secret = getUrlSecret()) {
  const exp = Math.floor(now / 1000) + TICKET_TTL_SECONDS
  const b64 = Buffer.from(JSON.stringify({ driveId, userId, projectId, exp })).toString('base64url')
  return { ticket: `${b64}.${ticketMac(b64, secret)}`, exp }
}

// Returns { driveId, userId, projectId, exp } when the signature is valid and the payload is
// well-formed, otherwise null. Expiry is checked by the caller (isTicketExpired).
export function verifyTicket(ticket, secret = getUrlSecret()) {
  if (typeof ticket !== 'string' || ticket.length > TICKET_MAX_LEN) return null
  const parts = ticket.split('.')
  if (parts.length !== 2) return null
  const [b64, sig] = parts
  if (!b64 || !B64URL_RE.test(b64) || !sig || !B64URL_RE.test(sig)) return null
  const want = Buffer.from(ticketMac(b64, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let p
  try {
    p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    !p || typeof p !== 'object' ||
    typeof p.driveId !== 'string' || !DRIVE_ID_RE.test(p.driveId) ||
    typeof p.userId !== 'string' || !uuid.test(p.userId) ||
    typeof p.projectId !== 'string' || !uuid.test(p.projectId) ||
    !Number.isInteger(p.exp)
  ) return null
  return { driveId: p.driveId, userId: p.userId, projectId: p.projectId, exp: p.exp }
}

export const isTicketExpired = (t, now = Date.now()) => t.exp * 1000 <= now

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
