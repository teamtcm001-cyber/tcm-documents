// Vercel Serverless Function — removes an ORPHAN upload from Google Drive.
// Used when the browser finished (or started) uploading bytes to a session created by
// /api/drive-upload-session but then got a DEFINITE rejection when saving the `files` row
// (e.g. RLS refused the insert), so the Drive object would otherwise stay behind unreferenced.
//
// NON-DESTRUCTIVE: "discard" moves the object to the Google Drive TRASH (PATCH files/<id> {trashed:true}); this
// endpoint never deletes anything permanently. Drive keeps trashed items for ~30 days, so a wrong discard is
// recoverable: sign in to Drive as the storage account (the one that owns GOOGLE_REFRESH_TOKEN) -> Trash -> find
// the file by its name -> Restore. The Drive id does not change, so any files.storage_path that points at it works
// again immediately.
//
// Endpoint: POST /api/drive-upload-discard      Authorization: Bearer <supabase access token>
// Body:     { ticket }                          (the ticket returned by drive-upload-session)
// Returns:  200 { deleted: true | false }
//             true   the object was moved to the Drive trash (recoverable ~30 days), or it no longer exists
//                    at Google (404 = already gone)
//             false  the safety checks (parent folder / age) refused to touch it
//           409 { error: 'in_use' }   a `files` row already references this Drive id; nothing trashed
// Errors:   401/403/503 via requireUser | 400 bad_request (no ticket) | 403 forbidden (bad,
//           tampered, expired or somebody else's ticket) | 429 rate_limited | 503 (the files-row
//           check failed: fail closed, nothing trashed) | 502 upstream_error (Google failed).
// Env:      SUPABASE_URL, SUPABASE_ANON_KEY, DRIVE_URL_SECRET, GOOGLE_CLIENT_ID,
//           GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID
//
// SAFETY CHAIN (a caller can never trash a file that has a database row, or that they were not
// issued a ticket for). In this order, each step must pass:
//   1. the ticket verifies (HMAC, not expired) AND belongs to the calling user;
//   2. with the CALLER's own token: files?storage_path=eq.<driveId> returns no row; any row ->
//      409 in_use; a failed query -> 503 (fail closed);
//   3. Drive files.get with the server token: the file must be inside GOOGLE_DRIVE_FOLDER_ID and
//      created less than 2 hours ago;
//   4. only then PATCH files/<id> {"trashed": true} (works under the drive.file scope for app-created files).
// RESIDUAL RISK of step 2: it runs under the caller's RLS, so it can only see rows the caller can read. A row in
// a project the caller lost access to during the ticket's 1 h life (or a row an admin inserted for the same
// driveId) would be invisible, and the object would be trashed although a row points at it. Because the action is
// a TRASH and not a delete, this is recoverable (see above), and the folder + 2 h checks and the one-hour ticket
// bound the window. (A "can still edit the project" re-check was deliberately NOT added: the
// normal reason for a definite rejection IS lost access, and that is exactly when the orphan must be removable.)
// Never log tickets, URLs, tokens or Google bodies.
//
// Rate limiting (per warm instance, best effort): 200 calls / hour / user.
import { ApiError, rateLimit, readJsonBody, requireEnv, requireUser, sendError, supabaseRest } from './_auth.js'
import { getUrlSecret, isTicketExpired, verifyTicket } from './_sign.js'
import { getServerGoogleToken, googleFetch, upstreamError } from './_upload.js'

const RATE_MAX = 200
const RATE_WINDOW_MS = 60 * 60 * 1000
const MAX_AGE_MS = 2 * 60 * 60 * 1000

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      throw new ApiError(405, 'method_not_allowed')
    }
    const { user, token } = await requireUser(req)
    if (!rateLimit(`drive-upload-discard:${user.id}`, RATE_MAX, RATE_WINDOW_MS)) {
      throw new ApiError(429, 'rate_limited')
    }
    const body = readJsonBody(req)
    if (typeof body.ticket !== 'string' || !body.ticket) {
      throw new ApiError(400, 'bad_request', 'ต้องระบุ ticket')
    }

    // ---- 1) ticket: signature, expiry, owner ----
    const ticket = verifyTicket(body.ticket, getUrlSecret())
    if (!ticket || isTicketExpired(ticket) || ticket.userId !== user.id) {
      throw new ApiError(403, 'forbidden')
    }
    const { driveId } = ticket
    const env = requireEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'])

    // ---- 2) is the object referenced by a files row? (caller's token; fail closed) ----
    const rows = await supabaseRest(token, `files?storage_path=eq.${encodeURIComponent(driveId)}&select=id&limit=1`)
    if (!rows.ok || !Array.isArray(rows.data)) throw new ApiError(503, 'auth_unavailable')
    if (rows.data.length > 0) {
      throw new ApiError(409, 'in_use', 'ไฟล์นี้ถูกบันทึกในระบบแล้ว จึงไม่ลบออก')
    }

    // ---- 3) Drive metadata: right folder, recently created ----
    const gToken = await getServerGoogleToken()
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}`
    const metaRes = await googleFetch(`${fileUrl}?fields=id,createdTime,parents`, { method: 'GET' }, gToken)
    if (metaRes.status === 404) return res.status(200).json({ deleted: true })
    if (!metaRes.ok) {
      console.error('drive-upload-discard: files.get failed', metaRes.status)
      throw upstreamError()
    }
    const meta = await metaRes.json().catch(() => null)
    const parents = meta && Array.isArray(meta.parents) ? meta.parents : []
    const created = meta && typeof meta.createdTime === 'string' ? Date.parse(meta.createdTime) : NaN
    const recent = Number.isFinite(created) && Date.now() - created < MAX_AGE_MS
    if (!meta || meta.id !== driveId || !parents.includes(env.GOOGLE_DRIVE_FOLDER_ID) || !recent) {
      return res.status(200).json({ deleted: false })
    }

    // ---- 4) move to the Drive trash (recoverable; NOT a permanent delete) ----
    const trashRes = await googleFetch(
      fileUrl,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) },
      gToken
    )
    if (trashRes.status === 404) return res.status(200).json({ deleted: true })
    if (!trashRes.ok) {
      console.error('drive-upload-discard: trash failed', trashRes.status)
      throw upstreamError()
    }
    return res.status(200).json({ deleted: true })
  } catch (err) {
    return sendError(res, err)
  }
}
