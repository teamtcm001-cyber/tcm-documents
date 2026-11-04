// Vercel Serverless Function — mints short-lived signed URLs for /api/drive-file.
// The caller must be logged in AND be allowed (by Supabase RLS) to see the file row.
//
// Endpoint: POST /api/drive-url   (Authorization: Bearer <supabase access token>)
// Body:     { fileId, download?: boolean, name?: string }   or   { fileIds: [..<=50], download?, }
// Returns:  { url, expiresAt }                               or   { urls: { [id]: url }, expiresAt }
// Env:      SUPABASE_URL, SUPABASE_ANON_KEY, DRIVE_URL_SECRET
import { ApiError, readJsonBody, requireUser, sendError, supabaseRest, UUID_RE } from './_auth.js'
import { buildSignedUrl, DRIVE_ID_RE, getUrlSecret } from './_sign.js'

const MAX_BATCH = 50
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
      const urls = {}
      let expiresAt = null
      for (const row of Array.isArray(r.data) ? r.data : []) {
        if (!row || !DRIVE_ID_RE.test(String(row.storage_path || ''))) continue
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
