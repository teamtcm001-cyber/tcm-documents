// Vercel Serverless Function — mints short-lived signed URLs for /api/drive-file.
// The caller must be logged in AND be allowed (by Supabase RLS) to see the file row.
//
// Endpoint: POST /api/drive-url   (Authorization: Bearer <supabase access token>)
// Body:     { fileId, download?: boolean, name?: string, purpose?: 'view'|'download'|'reindex' }
//           or { fileIds: [..<=50], download? }   (batch = the ZIP download)
// Returns:  { url, expiresAt }                               or   { urls: { [id]: url }, expiresAt }
// Access log (scripts/file-access-log.sql): every link handed out is recorded first through the RPC
// log_file_access (as the signed-in person: auth.uid(), only files they may see) - single: 'download' when
// download:true, otherwise the given purpose ('view' default, 'reindex'); batch: 'zip'. FAIL CLOSED: if the
// log cannot be written no link is given (503 audit_unavailable). Before the script is run (function
// missing) files are served unlogged.
// Env:      SUPABASE_URL, SUPABASE_ANON_KEY, DRIVE_URL_SECRET
import { ApiError, readJsonBody, requireUser, sendError, supabaseRest, UUID_RE } from './_auth.js'
import { buildSignedUrl, DRIVE_ID_RE, getUrlSecret } from './_sign.js'

const MAX_BATCH = 50
const PURPOSES = ['view', 'download', 'reindex']

// -> the Set of ids the log covers (logged now or within the last 10 minutes) - links are signed ONLY for
// these; `null` = logging not installed yet (scripts/file-access-log.sql not run: serve as before).
// Throws 503 audit_unavailable when the log cannot be written (fail closed), 429 when the person's
// log rate cap is hit, 401 for an expired session.
async function logAccess(token, ids, action) {
  if (!ids.length) return new Set()
  let r
  try {
    r = await supabaseRest(token, 'rpc/log_file_access', {
      method: 'POST',
      body: JSON.stringify({ p_file_ids: ids, p_action: action }),
    })
  } catch {
    // network / timeout: still fail closed, with the audit message (not "auth unavailable")
    throw new ApiError(503, 'audit_unavailable', AUDIT_FAILED)
  }
  if (r.ok) {
    // an older install returned a number: treat it as "all logged" only if it is not an array
    if (Array.isArray(r.data)) return new Set(r.data.map((x) => String(x).toLowerCase()))
    console.error('file access log: unexpected answer shape')
    throw new ApiError(503, 'audit_unavailable', AUDIT_FAILED)
  }
  const code = r.data && typeof r.data === 'object' ? String(r.data.code || '') : ''
  // ONLY "function not found" means "not installed"; any other 404 (e.g. the table dropped by hand)
  // must not open an unlogged path
  if (code === 'PGRST202') return null
  if (r.status === 401 || code === 'PGRST301' || code === '28000') throw new ApiError(401, 'unauthorized')
  if (code === '54000') throw new ApiError(429, 'rate_limited', 'เปิด/ดาวน์โหลดไฟล์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่')
  console.error('file access log failed:', r.status, code.slice(0, 12))
  throw new ApiError(503, 'audit_unavailable', AUDIT_FAILED)
}
const AUDIT_FAILED = 'บันทึกการเข้าถึงไฟล์ไม่สำเร็จ จึงยังเปิดไฟล์ไม่ได้ กรุณาลองใหม่อีกครั้ง'

// files.id is a uuid. Anything else is rejected here (400) so PostgREST never sees it
// (an invalid uuid would otherwise surface as a 22P02 -> 502).
function validId(v) {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      throw new ApiError(405, 'method_not_allowed')
    }
    // Authenticate FIRST: an unauthenticated caller must learn nothing about server
    // configuration (a missing DRIVE_URL_SECRET would otherwise answer 500 to anyone).
    const { token } = await requireUser(req)
    getUrlSecret() // then fail fast with server_not_configured (env NAMES only go to the server log)
    const body = readJsonBody(req)

    const download = body.download === true
    const name = typeof body.name === 'string' ? body.name : ''

    // ---- batch ----
    if (body.fileIds !== undefined) {
      if (!Array.isArray(body.fileIds) || body.fileIds.length === 0 || body.fileIds.length > MAX_BATCH) {
        throw new ApiError(400, 'bad_request', `fileIds ต้องเป็นรายการ 1-${MAX_BATCH} รายการ`)
      }
      // Batch: invalid ids are DROPPED (the rest still get URLs); invisible ids stay silently
      // absent from `urls`, exactly like before.
      const ids = []
      for (const raw of body.fileIds) {
        const id = validId(raw)
        if (id && !ids.includes(id)) ids.push(id)
      }
      if (ids.length === 0) return res.status(200).json({ urls: {}, expiresAt: null })
      // `name` is meaningless for a batch (each file has its own); download flag applies to all.
      const r = await supabaseRest(token, `files?id=in.(${ids.join(',')})&select=id,storage_path,name`)
      if (!r.ok) throw new ApiError(502, 'upstream_error')
      const rows = (Array.isArray(r.data) ? r.data : []).filter((row) => row && DRIVE_ID_RE.test(String(row.storage_path || '')))
      const logged = await logAccess(token, rows.map((row) => String(row.id).toLowerCase()), 'zip')
      const urls = {}
      let expiresAt = null
      for (const row of rows) {
        // a file the log does not cover (access revoked a moment ago) gets no link
        if (logged && !logged.has(String(row.id).toLowerCase())) continue
        const s = buildSignedUrl({ fileId: row.storage_path, download, name: download ? row.name : '' })
        urls[String(row.id)] = s.url
        expiresAt = s.expiresAt
      }
      return res.status(200).json({ urls, expiresAt })
    }

    // ---- single ----
    const id = validId(body.fileId)
    if (!id) throw new ApiError(400, 'bad_request', 'fileId ไม่ถูกต้อง')
    const r = await supabaseRest(token, `files?id=eq.${id}&select=id,storage_path,name&limit=1`)
    if (!r.ok) throw new ApiError(502, 'upstream_error')
    const row = Array.isArray(r.data) ? r.data[0] : null
    // Same answer whether the file is missing or merely not visible to this user.
    if (!row || !DRIVE_ID_RE.test(String(row.storage_path || ''))) throw new ApiError(404, 'not_found')
    const purpose = download ? 'download' : PURPOSES.includes(body.purpose) && body.purpose !== 'download' ? body.purpose : 'view'
    const logged = await logAccess(token, [String(row.id).toLowerCase()], purpose)
    if (logged && !logged.has(String(row.id).toLowerCase())) throw new ApiError(404, 'not_found')

    const { url, expiresAt } = buildSignedUrl({
      fileId: row.storage_path,
      download,
      name: download ? name || row.name || '' : '',
    })
    return res.status(200).json({ url, expiresAt })
  } catch (err) {
    return sendError(res, err)
  }
}
