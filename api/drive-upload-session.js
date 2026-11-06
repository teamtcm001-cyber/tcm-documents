// Vercel Serverless Function — creates a Google Drive RESUMABLE UPLOAD SESSION for the browser.
// The browser then PUTs the file bytes straight to the returned session URI (so the bytes never
// pass through Vercel and its request-body limit) and NO Google credential ever reaches the
// browser: the OAuth access token is used only here, on the server, to initiate the session.
//
// Endpoint: POST /api/drive-upload-session      Authorization: Bearer <supabase access token>
// Body:     { projectId: uuid, name: string, size: integer bytes, mimeType?: string }
// Returns:  200 { uploadUrl, driveId, ticket, expiresAt }       (Cache-Control: no-store)
//             uploadUrl  Google session URI (https, *.googleapis.com); creates exactly ONE file of
//                        the declared size with the pre-assigned id `driveId`
//             driveId    the Drive file id to store in files.storage_path
//             ticket     opaque HMAC-signed token { driveId, userId, projectId, exp }; the only
//                        thing /api/drive-upload-discard accepts to remove an orphan upload
//             expiresAt  ISO time, 1 h after issue (ticket lifetime)
// Errors:   401 unauthorized | 403 account_disabled | 403 password_change_required | 503 (as every
//           endpoint, via requireUser) | 400 bad_request | 413 file_too_large | 403 forbidden
//           (no edit right on THAT project, or a foreign Origin) | 429 rate_limited |
//           502 upstream_error (any Google failure; generic text, no Google body) | 503 if the
//           permission check itself failed.
// Allowed:  the caller must be able to EDIT that specific project: role admin (any project), or
//           role user with project_members.role = 'editor' FOR THAT PROJECT. exec / viewer-only /
//           editor-of-another-project -> 403. The check runs with the CALLER's own token through
//           PostgREST (rpc can_edit_project) so the database's RLS helper is the single source
//           of truth.
// Env:      SUPABASE_URL, SUPABASE_ANON_KEY, DRIVE_URL_SECRET, GOOGLE_CLIENT_ID,
//           GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID,
//           APP_ORIGINS (optional, comma-separated extra origins that may upload).
//
// SECURITY NOTES (read before changing anything here)
// 1. The browser never receives a Google credential. It gets a session URI that is bound by
//    Google to one file (id, name, parent folder, size and type are fixed HERE, server-side,
//    from validated values) and cannot be used to read, list, overwrite or delete anything.
//    (This replaces the former token-issuing endpoint, which handed every editor a real
//    bearer token for every file the app had created.)
// 2. GOOGLE_REFRESH_TOKEN is used on the server only (drive-file, drive-upload-session,
//    drive-upload-discard). It should still be minted with ONLY
//        https://www.googleapis.com/auth/drive.file
//    so that even a server-side bug cannot reach files outside those the app created.
// 3. Origin: Google's session URI only answers browser CORS preflights for the Origin that was
//    sent when the session was initiated, so we forward the app origin. It is accepted only when
//    it is same-origin (host == Host header) or listed in APP_ORIGINS; anything else -> 403.
// 4. Never log tickets, session URIs, access tokens or Google response bodies.
//
// Rate limiting (per warm instance, best effort): 600 sessions / hour / user.
import { ApiError, rateLimit, readJsonBody, requireEnv, requireUser, sendError, UUID_RE } from './_auth.js'
import { cleanUploadName, getUrlSecret, signTicket, DRIVE_ID_RE } from './_sign.js'
import { assertCanEditProject, isForbiddenMime, getServerGoogleToken, googleFetch, resolveAppOrigin, safeSessionUrl, upstreamError } from './_upload.js'

const RATE_MAX = 600 // bulk drawing imports are legitimate; discard keeps its own 200/h bucket
const RATE_WINDOW_MS = 60 * 60 * 1000
const MAX_SIZE = 1024 * 1024 * 1024 // 1 GiB
const NAME_MAX = 255
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      throw new ApiError(405, 'method_not_allowed')
    }
    // Authenticate first so unauthenticated callers learn nothing else.
    const { user, profile, token } = await requireUser(req)
    const body = readJsonBody(req)

    // ---- validate input (no database or Google call for malformed requests) ----
    if (typeof body.projectId !== 'string' || !UUID_RE.test(body.projectId)) {
      throw new ApiError(400, 'bad_request', 'ต้องระบุ projectId ที่ถูกต้อง')
    }
    const projectId = body.projectId.toLowerCase()

    // control + bidi/format characters stripped; the 255 limit counts code points, not UTF-16 units
    const name = cleanUploadName(body.name, NAME_MAX + 1)
    if (name.length < 1 || Array.from(name).length > NAME_MAX) {
      throw new ApiError(400, 'bad_request', 'ชื่อไฟล์ต้องมีความยาว 1-255 ตัวอักษร')
    }

    const size = body.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new ApiError(400, 'bad_request', 'ขนาดไฟล์ต้องเป็นจำนวนเต็มไบต์ที่มากกว่า 0')
    }
    if (size > MAX_SIZE) {
      throw new ApiError(413, 'file_too_large', 'ไฟล์ใหญ่เกินไป รองรับสูงสุด 1 GB ต่อไฟล์')
    }

    const mimeType =
      typeof body.mimeType === 'string' && body.mimeType.length <= 100 && MIME_RE.test(body.mimeType) && !isForbiddenMime(body.mimeType)
        ? body.mimeType
        : 'application/octet-stream'

    // ---- may this caller edit THAT project? ----
    await assertCanEditProject(profile, token, projectId, 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์ในโครงการนี้')

    // ---- app origin that Google must allow for CORS on the session URI ----
    const origin = resolveAppOrigin(req)
    if (!origin) throw new ApiError(403, 'forbidden', 'ไม่อนุญาตให้อัปโหลดจากต้นทางนี้')

    if (!rateLimit(`drive-upload-session:${user.id}`, RATE_MAX, RATE_WINDOW_MS)) {
      throw new ApiError(429, 'rate_limited')
    }

    const env = requireEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'])
    getUrlSecret() // fail with server_not_configured BEFORE creating anything at Google

    const gToken = await getServerGoogleToken()

    // ---- 1) one pre-assigned Drive id (so the ticket can name the file before bytes exist) ----
    const idRes = await googleFetch(
      'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive',
      { method: 'GET' },
      gToken
    )
    if (!idRes.ok) {
      console.error('drive-upload-session: generateIds failed', idRes.status)
      throw upstreamError()
    }
    const idJson = await idRes.json().catch(() => null)
    const driveId = idJson && Array.isArray(idJson.ids) ? idJson.ids[0] : null
    if (typeof driveId !== 'string' || !DRIVE_ID_RE.test(driveId)) {
      console.error('drive-upload-session: generateIds returned no usable id')
      throw upstreamError()
    }

    // ---- 2) initiate the resumable upload (the server, not the browser, holds the token) ----
    const initRes = await googleFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
          Origin: origin,
        },
        body: JSON.stringify({ id: driveId, name, parents: [env.GOOGLE_DRIVE_FOLDER_ID], mimeType }),
      },
      gToken
    )
    if (!initRes.ok) {
      console.error('drive-upload-session: resumable initiation failed', initRes.status)
      throw upstreamError()
    }
    const uploadUrl = safeSessionUrl(initRes.headers.get('location'))
    if (!uploadUrl) {
      console.error('drive-upload-session: unusable session location')
      throw upstreamError()
    }

    const { ticket, exp } = signTicket({ driveId, userId: user.id, projectId })
    return res.status(200).json({
      uploadUrl,
      driveId,
      ticket,
      expiresAt: new Date(exp * 1000).toISOString(),
    })
  } catch (err) {
    return sendError(res, err)
  }
}
