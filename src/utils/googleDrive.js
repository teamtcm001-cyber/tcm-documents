// Client-side helper for uploading files to Google Drive.
// Upload goes directly browser -> Google Drive using a short-lived token minted
// by /api/drive-token, so file bytes never pass through our own serverless
// function (avoids Vercel's request body size limit).
//
// /api/drive-token requires the signed-in person's Bearer token AND the target project:
//   GET /api/drive-token?projectId=<uuid>
// and is role-gated per project (admin, or an EDITOR of that project). The caller passes
// `authFetch` (src/api/supabase.js) so this module stays free of Supabase imports.
//
// Reading files is NOT done here any more: files are served only through short-lived
// signed URLs (see getSignedFileUrl in src/api/supabase.js).

const SESSION_EXPIRED = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
const UNAVAILABLE = 'ระบบตรวจสอบสิทธิ์ไม่ตอบสนอง ลองใหม่อีกครั้ง'

// Error with a Thai, user-safe message and a stable `code`:
//   unauthorized | forbidden | rate_limited | auth_unavailable | password_change_required | network | drive | error
const driveError = (message, code, status) => Object.assign(new Error(message), { code, status })

// Tokens are cached PER PROJECT (never globally: the server checks the role for that project) for a few
// minutes, so a batch of files does not mint one token each. Cleared on sign-in/out and on any access problem.
const TOKEN_TTL_MS = 5 * 60 * 1000
const tokenCache = new Map() // projectId -> { accessToken, folderId, exp }

export function clearDriveTokenCache() {
  tokenCache.clear()
}

export async function getDriveUploadToken(authFetch, projectId, { fresh = false } = {}) {
  if (!projectId) throw driveError('ไม่ได้ระบุโครงการที่จะอัปโหลด', 'error')
  const key = String(projectId)
  const hit = tokenCache.get(key)
  if (!fresh && hit && hit.exp > Date.now()) return { accessToken: hit.accessToken, folderId: hit.folderId }
  tokenCache.delete(key)

  let res
  try {
    res = await authFetch(`/api/drive-token?projectId=${encodeURIComponent(key)}`)
  } catch (err) {
    if (err?.code === 'unauthorized' || err?.code === 'auth_unavailable') throw err
    throw driveError('เชื่อมต่อระบบไม่ได้ ไม่สามารถขอสิทธิ์อัปโหลดได้', 'network')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const code = body?.error
    if (res.status === 401) throw driveError(SESSION_EXPIRED, 'unauthorized', 401)
    if (res.status === 503 || code === 'auth_unavailable') throw driveError(UNAVAILABLE, 'auth_unavailable', res.status)
    if (res.status === 429 || code === 'rate_limited') {
      throw driveError('อัปโหลดบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'rate_limited', 429)
    }
    if (res.status === 403) {
      if (code === 'password_change_required') {
        throw driveError('ต้องตั้งรหัสผ่านใหม่ของคุณเองก่อน จึงจะอัปโหลดไฟล์ได้', 'password_change_required', 403)
      }
      if (code === 'account_disabled') throw driveError('บัญชีนี้ถูกปิดการใช้งาน', 'account_disabled', 403)
      throw driveError(body?.message || 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์ในโครงการนี้', 'forbidden', 403)
    }
    throw driveError(body?.message || 'ไม่สามารถขอสิทธิ์อัปโหลดไป Google Drive ได้', 'error', res.status)
  }
  const data = await res.json().catch(() => null)
  if (!data?.accessToken || !data?.folderId) throw driveError('Google Drive ยังไม่ได้ตั้งค่า', 'error')
  const ttl = Math.min(TOKEN_TTL_MS, Math.max(0, (Number(data.expiresIn) || 0) * 1000 - 120000))
  if (ttl > 0) tokenCache.set(key, { accessToken: data.accessToken, folderId: data.folderId, exp: Date.now() + ttl })
  return data
}

export async function uploadToDrive(file, authFetch, projectId) {
  const send = async (fresh) => {
    const { accessToken, folderId } = await getDriveUploadToken(authFetch, projectId, { fresh })
    const metadata = { name: file.name, parents: [folderId] }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('file', file)
    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    })
  }

  let res = await send(false)
  if (res.status === 401) {
    // a cached token that Google no longer accepts: get a fresh one once
    res = await send(true)
  }
  if (!res.ok) {
    tokenCache.delete(String(projectId))
    const errText = await res.text().catch(() => '')
    throw driveError(`อัปโหลดขึ้น Google Drive ไม่สำเร็จ: ${errText}`, 'drive', res.status)
  }
  const data = await res.json()
  return data.id
}

// DANGEROUS if misused: the caller (uploadFile) may only call this after the insert was DEFINITELY rejected and a
// re-select by storage_path proved that no files row references the object.
// Best effort: remove a file we just uploaded when saving its database row failed, so no unreachable object
// stays in Drive. Uses the project's cached token (drive.file scope may delete files this app created).
// Never throws; if it does not work the object is simply left behind (same as before).
export async function discardDriveUpload(projectId, fileId) {
  try {
    const hit = tokenCache.get(String(projectId))
    if (!hit || !fileId) return false
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hit.accessToken}` },
    })
    return res.ok
  } catch {
    return false
  }
}
