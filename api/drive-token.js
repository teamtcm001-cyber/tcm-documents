// Vercel Serverless Function — issues a short-lived Google Drive access token to the client
// so uploads go directly browser -> Google Drive (bypasses Vercel's request body limit).
//
// Endpoint: GET /api/drive-token?projectId=<uuid>     (also accepts POST { "projectId": "<uuid>" })
//           Authorization: Bearer <supabase access token>
// Allowed:  the caller must be able to EDIT that specific project: role admin (any project),
//           or role user with project_members.role = 'editor' FOR THAT PROJECT.
//           exec / viewer-only / editor-of-another-project -> 403 forbidden.
//           Missing or non-UUID projectId -> 400 bad_request.
//           The check runs with the CALLER's own token through PostgREST (rpc can_edit_project),
//           so the database's RLS helper is the single source of truth.
// Returns:  { accessToken, expiresIn, folderId }
// Env:      SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//           GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID
//
// SECURITY NOTES (read before changing anything here)
// 1. This endpoint hands a real Google OAuth bearer token to the browser. Its reach is
//    whatever scope the REFRESH TOKEN was minted with - the server cannot narrow it here.
//    GOOGLE_REFRESH_TOKEN MUST therefore be minted with ONLY
//        https://www.googleapis.com/auth/drive.file
//    (files created by this app). If it was ever minted with the broader `drive` scope,
//    every authorised editor can read/delete the whole Drive, so re-mint it.
// 2. The token is not bound to the project that was checked: an editor of project A who
//    gets a token can use it against any file the app created. The projectId check stops
//    people who may not upload at all (and gives an audit-able per-project gate); it does
//    NOT confine what a malicious editor can do with the token during its ~1 h life.
// 3. Long-term fix (NOT implemented): server-created resumable upload session.
//      a. Browser calls POST /api/drive-upload-session { projectId, name, size, mimeType }.
//      b. Server authorises exactly as above, validates type/size/extension, then itself calls
//         POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable
//         (metadata: { name, parents:[GOOGLE_DRIVE_FOLDER_ID] }, X-Upload-Content-Type /
//         X-Upload-Content-Length set from the validated values, Origin forwarded so the
//         session URI allows browser CORS) using the server-held token.
//      c. Server returns ONLY the session URI from the `Location` header. The browser PUTs
//         the bytes straight to that URI (chunked/resumable), so no bearer token ever reaches
//         the client and the URI can create exactly one file of the declared size.
//      d. Browser (or server on a callback) then records the resulting Drive file id in
//         `files`; the server can also verify it via files.get before accepting it.
//
// Rate limiting (per warm instance, best effort) is kept: 60 calls / hour / user.
import { ApiError, getQuery, rateLimit, readJsonBody, requireEnv, requireUser, sendError, supabaseRest, UUID_RE } from './_auth.js'
import { getOAuthClient } from './_drive.js'

const RATE_MAX = 60
const RATE_WINDOW_MS = 60 * 60 * 1000

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      throw new ApiError(405, 'method_not_allowed')
    }
    // Authenticate first so unauthenticated callers learn nothing else.
    const { user, profile, token } = await requireUser(req)

    // ---- which project? (query string first, POST body as an alternative) ----
    let rawProject = getQuery(req).projectId
    if (rawProject === undefined && req.method === 'POST') rawProject = readJsonBody(req).projectId
    if (typeof rawProject !== 'string' || !UUID_RE.test(rawProject)) {
      throw new ApiError(400, 'bad_request', 'ต้องระบุ projectId ที่ถูกต้อง')
    }
    const projectId = rawProject.toLowerCase()

    // ---- may this caller edit THAT project? ----
    if (profile.role !== 'admin') {
      if (profile.role !== 'user') throw new ApiError(403, 'forbidden', 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์')
      // public.can_edit_project(p uuid) is evaluated by Postgres for auth.uid() = this caller.
      const r = await supabaseRest(token, 'rpc/can_edit_project', {
        method: 'POST',
        body: JSON.stringify({ p: projectId }),
      })
      if (!r.ok) throw new ApiError(503, 'auth_unavailable')
      if (r.data !== true) throw new ApiError(403, 'forbidden', 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์ในโครงการนี้')
    }

    if (!rateLimit(`drive-token:${user.id}`, RATE_MAX, RATE_WINDOW_MS)) {
      throw new ApiError(429, 'rate_limited')
    }

    const env = requireEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'])

    let accessToken
    let expiresIn = 3599
    try {
      const client = getOAuthClient()
      const { token: gToken, res: tokenRes } = await client.getAccessToken()
      accessToken = gToken
      expiresIn = tokenRes?.data?.expires_in || expiresIn
    } catch {
      console.error('drive-token: google token request failed')
    }
    if (!accessToken) throw new ApiError(502, 'upstream_error', 'ไม่สามารถขอสิทธิ์จาก Google Drive ได้')

    return res.status(200).json({ accessToken, expiresIn, folderId: env.GOOGLE_DRIVE_FOLDER_ID })
  } catch (err) {
    return sendError(res, err)
  }
}
