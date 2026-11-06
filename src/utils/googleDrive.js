// Client-side helper for uploading files to Google Drive.
//
// The browser NEVER receives a Google credential. Uploading works with a server-created resumable session:
//   1. POST /api/drive-upload-session { projectId, name, size, mimeType }   (via `authFetch`: Bearer token)
//        -> { uploadUrl, driveId, ticket, expiresAt }
//      The server checks that the person may edit THAT project, creates the Drive resumable session with its own
//      credential and hands back only the one-file session URI (`uploadUrl`), the Drive id the file will get
//      (`driveId`) and an opaque `ticket` that proves the session to /api/drive-upload-discard.
//   2. PUT the bytes straight to `uploadUrl` (browser -> Google, no Authorization header), so the file does not
//      pass through our serverless functions (Vercel's request size limit). The answer { id } must equal `driveId`.
//      A dropped/stalled connection, 5xx, 408, 429 or bare 308 is resumed (max RESUME_LIMIT times) by asking Google
//      which bytes it already holds (PUT with `Content-Range: bytes */<size>`) and sending the rest. A session that
//      Google no longer knows (404 / 410), or whose committed range cannot be read (308 without `Range`), is
//      replaced by ONE new session, never more.
//   3. If saving the database row is DEFINITELY rejected afterwards, supabase.js calls discardDriveUpload() with
//      the ticket so the server can remove the orphan (moved to the Drive trash; the server re-checks that no files row uses it).
//
// `authFetch` is passed in (src/api/supabase.js) so this module stays free of Supabase imports.
// Reading files is NOT done here: files are served only through short-lived signed URLs (getSignedFileUrl).

const SESSION_EXPIRED = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
const UNAVAILABLE = 'ระบบตรวจสอบสิทธิ์ไม่ตอบสนอง ลองใหม่อีกครั้ง'
const FILE_TOO_LARGE = 'ไฟล์ใหญ่เกินที่ระบบรองรับ (สูงสุด 1 GB)'

const RESUME_LIMIT = 3 // resumes after a network error / 5xx / 408 / 429 on the byte upload
const RESUME_DELAY_MS = 400 // times the attempt number

// Error with a Thai, user-safe message and a stable `code`:
//   unauthorized | forbidden | rate_limited | auth_unavailable | password_change_required | account_disabled
//   | file_too_large | upstream_error | network | drive | error
// UploadModal stops the rest of a batch only for the first group (see its STOP_CODES); the others are per file.
const driveError = (message, code, status) => Object.assign(new Error(message), { code, status })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1. the session ---------------------------------------------------------------------------------------------
async function createUploadSession(file, authFetch, projectId) {
  if (!projectId) throw driveError('ไม่ได้ระบุโครงการที่จะอัปโหลด', 'error')

  let res
  try {
    res = await authFetch('/api/drive-upload-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: String(projectId),
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      }),
    })
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
    if (res.status === 413 || code === 'file_too_large') throw driveError(FILE_TOO_LARGE, 'file_too_large', 413)
    if (res.status === 403) {
      if (code === 'password_change_required') {
        throw driveError('ต้องตั้งรหัสผ่านใหม่ของคุณเองก่อน จึงจะอัปโหลดไฟล์ได้', 'password_change_required', 403)
      }
      if (code === 'account_disabled') throw driveError('บัญชีนี้ถูกปิดการใช้งาน', 'account_disabled', 403)
      throw driveError(body?.message || 'บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์ในโครงการนี้', 'forbidden', 403)
    }
    if (res.status === 502 || code === 'upstream_error') {
      // Google Drive hiccup: this file fails but the next one may work, and trying again later is fine
      throw driveError('Google Drive ไม่ตอบสนองชั่วคราว กรุณาลองใหม่อีกครั้ง', 'upstream_error', res.status)
    }
    throw driveError(body?.message || 'ไม่สามารถขอสิทธิ์อัปโหลดไป Google Drive ได้', 'error', res.status)
  }

  const data = await res.json().catch(() => null)
  if (!data || typeof data.uploadUrl !== 'string' || !/^https:\/\//i.test(data.uploadUrl) || !data.driveId || !data.ticket) {
    throw driveError('Google Drive ยังไม่ได้ตั้งค่า', 'error')
  }
  return { uploadUrl: data.uploadUrl, driveId: String(data.driveId), ticket: String(data.ticket) }
}

// ---- 2. the bytes -----------------------------------------------------------------------------------------------
// Tuning knobs (an object so a test can shorten them): no upload progress for `stallMs` while the bytes are still
// being sent = the connection is dead -> abort and take the resume path. There is deliberately NO overall timeout
// (a 1 GB file may legitimately take long) and no guard while waiting for Google's answer after the last byte.
export const driveTuning = { stallMs: 120000, checkMs: 5000 }

// One PUT with XMLHttpRequest (fetch has no upload progress). Resolves { status, text, range } for ANY HTTP answer
// and rejects only when no answer arrived at all (connection dropped, offline, CORS failure, stalled upload).
function putOnce(url, body, headers, onBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    let lastProgress = Date.now()
    let allSent = false
    let timer = null
    const stop = () => { if (timer) clearInterval(timer); timer = null }
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => { lastProgress = Date.now(); if (onBytes) onBytes(e.loaded) }
      xhr.upload.onload = () => { allSent = true }
    }
    // only the byte-sending PUTs (they have a body) are guarded
    if (body) {
      timer = setInterval(() => {
        if (!allSent && Date.now() - lastProgress > driveTuning.stallMs) { stop(); xhr.abort() }
      }, driveTuning.checkMs)
    }
    xhr.onload = () => { stop(); resolve({ status: xhr.status, text: xhr.responseText, range: xhr.getResponseHeader('Range') }) }
    xhr.onerror = () => { stop(); reject(new Error('network')) }
    xhr.ontimeout = () => { stop(); reject(new Error('network')) }
    xhr.onabort = () => { stop(); reject(new Error('network')) }
    xhr.send(body)
  })
}

const isComplete = (r) => r.status === 200 || r.status === 201
// worth another attempt (the connection or Google had a hiccup); every other 4xx is final.
// 308 here = "Resume Incomplete" where a final answer was expected (e.g. a bare 308 on the whole-file PUT): ask what Google holds.
const isTransient = (r) => r.status >= 500 || r.status === 408 || r.status === 429 || r.status === 308
const isSessionGone = (r) => r.status === 404 || r.status === 410

// bytes Google already holds, from a 308 answer's `Range: bytes=0-<last>`; null = no readable Range header
// (nothing stored yet, OR the header exists but CORS does not expose it - the two cannot be told apart)
function committedBytes(range) {
  const m = /bytes=0-(\d+)/i.exec(range || '')
  return m ? Number(m[1]) + 1 : null
}

// -> { id: string|null, size: number|null } from a completed answer (200/201); either may be missing
function parseComplete(r) {
  try {
    const j = JSON.parse(r.text || '')
    const id = typeof j?.id === 'string' && j.id ? j.id : null
    const size = j?.size !== undefined && j?.size !== null && Number.isFinite(Number(j.size)) ? Number(j.size) : null
    return { id, size }
  } catch {
    return { id: null, size: null }
  }
}

const SESSION_GONE = Symbol('session-gone')

// -> the Drive file id, or SESSION_GONE (start over with a new session); throws driveError otherwise
async function sendBytes(file, session, onProgress) {
  const uploadUrl = session.uploadUrl
  const size = file.size
  const contentType = file.type || 'application/octet-stream'
  const report = (loaded) => onProgress && onProgress(size > 0 ? Math.min(99, Math.floor((loaded / size) * 100)) : 0)

  let start = 0
  let resumes = 0
  let pendingProbe = false
  let fromProbe = false

  for (;;) {
    let r = null
    try {
      if (pendingProbe) {
        // which part did Google keep?
        const probe = await putOnce(uploadUrl, null, { 'Content-Range': `bytes */${size}` })
        if (probe.status === 308) {
          const committed = committedBytes(probe.range)
          // No readable Range header is ambiguous (empty session, or Range not exposed to the browser). Resending from
          // byte 0 without Content-Range onto a possibly part-filled session is unsafe: start over with a NEW session.
          if (committed === null) return SESSION_GONE
          if (committed >= size) return SESSION_GONE // Google claims everything but never finalised: do not guess
          start = committed
          r = null
        } else {
          r = probe // 200/201 = already complete, 404/410 = gone, 5xx = try again, other 4xx = final
          fromProbe = true
        }
        pendingProbe = false
      }
      if (r === null) {
        const headers = { 'Content-Type': contentType }
        if (start > 0) headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`
        const base = start
        fromProbe = false
        r = await putOnce(uploadUrl, start > 0 ? file.slice(start) : file, headers, (loaded) => report(base + loaded))
      }
    } catch {
      r = { status: 0, text: '', range: null } // no answer at all
    }

    if (isComplete(r)) {
      const { id, size: gotSize } = parseComplete(r)
      if (gotSize !== null && gotSize !== size) {
        throw driveError('ขนาดไฟล์ที่ Google Drive บันทึกไม่ตรงกับไฟล์ต้นฉบับ อัปโหลดไม่สำเร็จ', 'drive', r.status)
      }
      // A completion PROBE whose body is empty/unparseable still means "complete": the session's announced id is the file.
      // A normal answer without an id is an error.
      const finalId = id || (fromProbe ? session.driveId : null)
      if (!finalId) throw driveError('Google Drive ตอบกลับไม่ถูกต้อง อัปโหลดไม่สำเร็จ', 'drive', r.status)
      onProgress && onProgress(100)
      return finalId
    }
    if (isSessionGone(r)) return SESSION_GONE
    if (r.status === 0 || isTransient(r)) {
      if (resumes >= RESUME_LIMIT) {
        throw r.status === 0
          ? driveError('การเชื่อมต่อขาดระหว่างอัปโหลด กรุณาลองใหม่อีกครั้ง', 'network')
          : driveError(`อัปโหลดขึ้น Google Drive ไม่สำเร็จ (HTTP ${r.status})`, 'drive', r.status)
      }
      resumes++
      await sleep(RESUME_DELAY_MS * resumes)
      pendingProbe = true
      continue
    }
    throw driveError(`อัปโหลดขึ้น Google Drive ไม่สำเร็จ (HTTP ${r.status})`, 'drive', r.status)
  }
}

// Uploads `file` into the project's Drive folder. onProgress(percent 0..100) reports the byte upload.
// -> { id: <Drive file id, equal to the id the server announced>, ticket }
export async function uploadToDrive(file, authFetch, projectId, onProgress) {
  let restarted = false
  for (;;) {
    const session = await createUploadSession(file, authFetch, projectId)
    const id = await sendBytes(file, session, onProgress)
    if (id === SESSION_GONE) {
      if (restarted) throw driveError('เซสชันอัปโหลดหมดอายุ กรุณาลองอัปโหลดใหม่อีกครั้ง', 'drive', 404)
      restarted = true // Drive forgot the session / its state is unreadable: start over ONCE with a new one
      onProgress && onProgress(0)
      continue
    }
    if (id !== session.driveId) {
      // never use an id the server did not announce
      throw driveError('Google Drive ตอบกลับไม่ตรงกับที่ขอ อัปโหลดไม่สำเร็จ', 'drive')
    }
    return { id, ticket: session.ticket }
  }
}

// ---- 3. orphan cleanup ------------------------------------------------------------------------------------------
// DANGEROUS if misused: the caller (uploadFile) may only call this after the insert was DEFINITELY rejected and a
// re-select by storage_path proved that no files row references the object. The server re-checks that too.
// Best effort, NEVER throws. -> 'deleted' | 'in_use' (409: a files row uses it, nothing deleted) | 'failed'
export async function discardDriveUpload(authFetch, ticket) {
  try {
    if (!ticket) return 'failed'
    const res = await authFetch('/api/drive-upload-discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    if (res.status === 409) return 'in_use'
    return res.ok ? 'deleted' : 'failed'
  } catch {
    return 'failed'
  }
}
