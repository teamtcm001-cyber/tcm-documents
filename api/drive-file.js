// Vercel Serverless Function — streams file bytes from Google Drive.
// Used from <img>/<iframe>/<a href>, so it cannot carry a JWT; access is granted
// by a short-lived HMAC-signed URL minted by POST /api/drive-url (which checks
// the user's permission). Bare ids are never accepted.
//
// Endpoint: GET /api/drive-file?fileId=..&exp=..&sig=..[&download=1&name=..]
// Env:      DRIVE_URL_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
import { ApiError, getQuery, requireEnv, sendError } from './_auth.js'
import { cleanName, DRIVE_ID_RE, getUrlSecret, verify } from './_sign.js'
import { getDrive } from './_drive.js'

const RANGE_RE = /^bytes=\d*-\d*$/ // single range only
const INLINE_UNSAFE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i

const one = (v) => (typeof v === 'string' ? v : undefined)

function contentDisposition(filename) {
  const safe = String(filename || 'file').replace(/[\r\n"\\]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      throw new ApiError(405, 'method_not_allowed')
    }
    const secret = getUrlSecret()

    // ---- verify signature BEFORE touching Drive; reveal nothing on failure ----
    const q = getQuery(req)
    const fileId = one(q.fileId)
    const sig = one(q.sig)
    const expStr = one(q.exp)
    const download = one(q.download) === '1'
    const name = cleanName(one(q.name) || '')
    const exp = /^\d{1,12}$/.test(expStr || '') ? Number(expStr) : NaN

    if (!fileId || !DRIVE_ID_RE.test(fileId) || !sig || !Number.isFinite(exp)) {
      throw new ApiError(403, 'forbidden')
    }
    if (!verify({ fileId, exp, download, name }, sig, secret)) throw new ApiError(403, 'forbidden')
    if (exp * 1000 < Date.now()) {
      throw new ApiError(403, 'link_expired', 'ลิงก์หมดอายุแล้ว กรุณาเปิดไฟล์ใหม่อีกครั้ง')
    }

    requireEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])

    // ---- stream from Drive ----
    const range = typeof req.headers.range === 'string' && RANGE_RE.test(req.headers.range) ? req.headers.range : null
    let meta
    let stream
    try {
      const drive = getDrive()
      meta = await drive.files.get({ fileId, fields: 'mimeType,name,size' })
      stream = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', ...(range ? { headers: { Range: range } } : {}) }
      )
    } catch (e) {
      const code = e && (e.code || e.status)
      console.error('drive-file upstream error:', code || 'unknown')
      if (code === 404) throw new ApiError(404, 'not_found')
      if (code === 416) {
        res.setHeader('Content-Range', 'bytes */*')
        throw new ApiError(416, 'range_not_satisfiable', 'ช่วงข้อมูลที่ขอไม่ถูกต้อง')
      }
      throw new ApiError(502, 'upstream_error')
    }

    const mime = meta.data.mimeType || 'application/octet-stream'
    res.setHeader('Content-Type', mime)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Referrer-Policy', 'no-referrer')

    // Active content (HTML/SVG/XML) from the app origin must never render inline.
    if (download || INLINE_UNSAFE.test(mime)) {
      res.setHeader('Content-Disposition', contentDisposition(name || meta.data.name || 'file'))
    }

    const h = (stream.headers && (stream.headers.get ? (k) => stream.headers.get(k) : (k) => stream.headers[k])) || (() => null)
    const partial = stream.status === 206
    const contentRange = partial ? h('content-range') : null
    const contentLength = h('content-length') || (!partial && meta.data.size ? String(meta.data.size) : null)
    if (contentRange) res.setHeader('Content-Range', contentRange)
    if (contentLength) res.setHeader('Content-Length', contentLength)
    res.status(partial ? 206 : 200)

    stream.data.on('error', () => {
      console.error('drive-file stream error')
      res.destroy()
    })
    res.on('close', () => {
      if (typeof stream.data.destroy === 'function') stream.data.destroy()
    })
    stream.data.pipe(res)
  } catch (err) {
    return sendError(res, err)
  }
}
