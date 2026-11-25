// Download many documents as ONE zip, built in the browser.
//
// The bytes never touch our own serverless functions beyond the existing GET /api/drive-file proxy
// (which streams them from Google Drive): this module asks POST /api/drive-url for signed links
// (batch endpoint, <= 50 ids per call, minted just-in-time), fetch()es every file with HTTP Range
// requests of RANGE_CHUNK bytes (so no single request is long or big; a dropped chunk is re-fetched
// on its own) and feeds them to `client-zip` (MIT, 2.6 kB gzipped, STORE only - PDFs / images are
// already compressed, UTF-8 file names are flagged, Zip64 when needed), which is lazy-imported.
//
// Output:
//   * Chrome / Edge (File System Access API: window.showSaveFilePicker) -> the zip is piped straight
//     to the chosen file, nothing but one 16 MB chunk is held in memory, any size works. Aborting
//     discards the partial output (the writable's swap file is never committed).
//   * everything else -> the zip is collected as a Blob and saved with <a download>; refused above
//     ZIP_BLOB_CAP_BYTES because the whole archive sits in memory.
//
// Pure logic: no React, no Supabase import (the caller injects `getUrls`), so it is unit-testable.

export const ZIP_BLOB_CAP_BYTES = 600 * 1024 * 1024 // desktop browsers without the File System Access API
export const ZIP_BLOB_CAP_MOBILE_BYTES = 150 * 1024 * 1024 // phones / tablets: far less memory per tab
export const LARGE_ZIP_FILES = 100 // the confirm dialog warns from here ...
export const LARGE_ZIP_BYTES = 2 * 1024 ** 3 // ... or from here
const MINT_TIMEOUT_MS = 30 * 1000 // POST /api/drive-url that never answers
export const RANGE_CHUNK = 16 * 1024 * 1024
const MINT_BATCH = 10 // files per signed-link request (server accepts 50); links live ~5 minutes
const URL_MAX_AGE_MS = 3 * 60 * 1000 // older links are minted again before use
const STALL_MS = 60 * 1000 // no byte for this long = the request is dropped and retried
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 700
const MAX_NAME_BYTES = 200 // UTF-8 bytes of one entry name (Thai = 3 bytes per character), extension included

export const MIXED_ZIP_LABEL = 'เอกสารที่เลือก'

// ---- errors -----------------------------------------------------------------------------------
// FileError: only this file is lost, the zip goes on. FatalError: nothing more can be done (session
// over, server down, output cannot be written), the run ends and the partial output is discarded.
export class FileError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'FileError'
    this.code = code || 'file_error'
  }
}
export class FatalError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'FatalError'
    this.code = code || 'fatal'
  }
}
const abortError = () => {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
const isAbort = (e) => e?.name === 'AbortError'

// ---- capability / planning ------------------------------------------------------------------------
export const supportsDiskStreaming = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'

export const isMobileBrowser = () => {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
// Memory cap of the Blob fallback (the whole archive sits in memory)
export const blobCapBytes = () => (isMobileBrowser() ? ZIP_BLOB_CAP_MOBILE_BYTES : ZIP_BLOB_CAP_BYTES)

export function fmtBytes(n) {
  const b = Number(n) || 0
  const one = (x) => String(Number(x.toFixed(1))) // 600 not 600.0
  if (b >= 1024 ** 3) return Number((b / 1024 ** 3).toFixed(2)) + ' GB'
  if (b >= 1024 ** 2) return one(b / 1024 ** 2) + ' MB'
  if (b >= 1024) return Math.round(b / 1024) + ' KB'
  return b + ' B'
}

// File rows come from the app (normalizeFile): `size` is in KB (rounded), `date` yyyy-mm-dd.
// -> { files (valid, de-duplicated by id), count, totalBytes (estimate), fsAvailable, overCap }
export function planZip(files, { fsAvailable = supportsDiskStreaming(), capBytes = blobCapBytes() } = {}) {
  const seen = new Set()
  const out = []
  for (const f of files || []) {
    if (!f || f.id === undefined || f.id === null || f.id === '') continue
    const id = String(f.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(f)
  }
  const totalBytes = out.reduce((s, f) => s + Math.max(0, Number(f.size) || 0) * 1024, 0)
  return {
    files: out, count: out.length, totalBytes, fsAvailable, capBytes,
    overCap: !fsAvailable && totalBytes > capBytes,
    large: out.length > LARGE_ZIP_FILES || totalBytes > LARGE_ZIP_BYTES,
  }
}

// ---- names ------------------------------------------------------------------------------------------
// control chars, Windows-illegal characters, path separators and bidi overrides (spoofed extensions) -> "_"
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
// zero-width / invisible characters (look-alike names, hidden suffixes) -> removed
const INVISIBLE = /[\u200b\u200c\u200d\u2060\u061c\ufeff]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const utf8Len = (str) => new TextEncoder().encode(str).length

function splitExt(name) {
  const m = /^(.+?)(\.[\p{L}\p{N}]{1,10})$/u.exec(name)
  return m ? [m[1], m[2]] : [name, '']
}

// longest prefix of `str` (whole code points) that fits in `maxBytes` UTF-8 bytes
function cutBytes(str, maxBytes) {
  let out = ''
  let used = 0
  for (const ch of str) {
    const n = utf8Len(ch)
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

// One safe zip entry name: no folders, no traversal, nothing Windows rejects, <= MAX_NAME_BYTES, never empty.
export function safeEntryName(raw) {
  let s = String(raw ?? '').replace(INVISIBLE, '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  if (!s) return 'file'
  const [base0, ext] = splitExt(s)
  let base = base0
  if (RESERVED.test(base.split('.')[0])) base = '_' + base
  if (utf8Len(base) + utf8Len(ext) > MAX_NAME_BYTES) base = cutBytes(base, Math.max(4, MAX_NAME_BYTES - utf8Len(ext)))
  return (base.replace(/[. ]+$/, '') || 'file') + ext
}

// "name.pdf", "name (2).pdf", "name (3).pdf" ... Windows / macOS treat names case-insensitively, and macOS
// stores them decomposed: compare NFC + lower case.
export function makeUniqueNamer() {
  const used = new Set()
  const key = (n) => n.normalize('NFC').toLowerCase()
  return (raw) => {
    const name = safeEntryName(raw)
    const [base, ext] = splitExt(name)
    let candidate = name
    for (let n = 2; used.has(key(candidate)); n++) candidate = `${base} (${n})${ext}`
    used.add(key(candidate))
    return candidate
  }
}

// Buddhist-era local date yyyy-mm-dd (Thai convention), e.g. 2569-11-25
export function buddhistDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear() + 543}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// <project code>_<date>.zip, or "เอกสารที่เลือก_<date>.zip" when the files come from several projects
export function zipFileName({ projectCode, date = new Date() } = {}) {
  const label = projectCode ? safeEntryName(projectCode).replace(/\.+$/, '') : MIXED_ZIP_LABEL
  return `${label}_${buddhistDate(date)}.zip`
}

// ---- save target (MUST be called synchronously from the click handler: the picker needs the gesture) --
// -> a Promise<FileSystemFileHandle>, or null when the browser cannot stream to disk.
export function pickSaveTarget(zipName) {
  if (!supportsDiskStreaming()) return null
  try {
    return Promise.resolve(
      window.showSaveFilePicker({
        suggestedName: zipName,
        types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
      })
    )
  } catch (e) {
    return Promise.reject(e)
  }
}

// ---- signed links, just in time --------------------------------------------------------------------
function makeUrlBook(files, getUrls, signal) {
  const ids = files.map((f) => String(f.id))
  const cache = new Map() // id -> { url, at } | { missing: true }
  const mint = async (list) => {
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw abortError()
      // own controller: aborted by the person's Cancel AND by the stall timeout (which then counts as a network hiccup)
      const ctrl = new AbortController()
      const onAbort = () => ctrl.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, MINT_TIMEOUT_MS)
      try {
        const timeout = new Promise((_, reject) => {
          ctrl.signal.addEventListener('abort', () => reject(timedOut ? Object.assign(new Error('mint timeout'), { code: 'network' }) : abortError()), { once: true })
        })
        timeout.catch(() => {})
        return await Promise.race([getUrls(list, { signal: ctrl.signal }), timeout])
      } catch (e) {
        if (signal.aborted || (isAbort(e) && !timedOut)) throw abortError()
        if (timedOut) e = Object.assign(new Error('เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่อีกครั้ง'), { code: 'network' })
        lastErr = e
        // only a hiccup is worth a second try; no session / no access / throttled is final
        if (!['network', 'upstream_error', 'bad_response'].includes(e?.code) && !/^http_5/.test(e?.code || '')) break
        await sleep(1200, signal)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }
    throw new FatalError(lastErr?.message || 'ขอลิงก์ไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', lastErr?.code || 'mint_failed')
  }
  return {
    // force = this link failed (expired): mint just this one again
    async get(file, { force = false } = {}) {
      const id = String(file.id)
      const hit = cache.get(id)
      if (!force && hit) {
        if (hit.missing) throw new FileError('ไม่พบไฟล์ หรือไม่มีสิทธิ์เปิดไฟล์นี้', 'not_found')
        if (Date.now() - hit.at < URL_MAX_AGE_MS) return hit.url
      }
      let list = [id]
      if (!force) {
        // the next files that still need a link (JIT: only a few ahead, so the first ones are not stale on arrival)
        const start = ids.indexOf(id)
        for (let i = start + 1; i < ids.length && list.length < MINT_BATCH; i++) {
          const c = cache.get(ids[i])
          if (!c) list.push(ids[i])
        }
      }
      const urls = await mint(list)
      const now = Date.now()
      for (const x of list) cache.set(x, urls[x] ? { url: urls[x], at: now } : { missing: true })
      const got = cache.get(id)
      if (got.missing) throw new FileError('ไม่พบไฟล์ หรือไม่มีสิทธิ์เปิดไฟล์นี้', 'not_found')
      return got.url
    },
  }
}

// Resolves / rejects like `promise`, but rejects with an AbortError as soon as `signal` aborts (an await that cannot
// be cancelled itself - the save picker, a dynamic import, getSession - must never keep Cancel waiting).
export function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      Promise.resolve(promise).catch(() => {})
      return reject(abortError())
    }
    const onAbort = () => reject(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (v) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal?.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---- fetching bytes ------------------------------------------------------------------------------
// One HTTP request, read completely. `expected` (bytes) = exact length the answer must have when the
// server says so. Aborts on user cancel and on a stalled connection. -> { status, headers, bytes }
async function requestBytes({ url, range, fetchFn, signal, onBytes }) {
  const ctrl = new AbortController()
  let stalled = false
  let timer
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      ctrl.abort()
    }, STALL_MS)
  }
  const onAbort = () => ctrl.abort()
  if (signal.aborted) throw abortError()
  signal.addEventListener('abort', onAbort, { once: true })
  let counted = 0
  try {
    arm()
    const res = await fetchFn(url, { signal: ctrl.signal, ...(range ? { headers: { Range: range } } : {}) })
    if (!res.ok) {
      // our own errors are small JSON ({error}); anything else just has no readable body
      const body = await res.json().catch(() => null)
      return { status: res.status, headers: res.headers, error: body?.error || '', bytes: null }
    }
    // Content-Length is only a promise about the bytes ON THE WIRE: it is absent for chunked answers, and with a
    // Content-Encoding (gzip ...) it is the COMPRESSED size while the body arrives decoded. Use it (to size the buffer and to
    // detect a cut-off body) only when it is present AND the body is not encoded; the Content-Range check in getChunk
    // (e - s + 1 === bytes.length) catches truncation in every other case.
    const lenHeader = res.headers.get('content-length')
    const encoded = !!res.headers.get('content-encoding') && !/^identity$/i.test(res.headers.get('content-encoding'))
    const declared = lenHeader == null || lenHeader === '' || encoded ? NaN : Number(lenHeader)
    const reader = res.body.getReader()
    let buf = Number.isFinite(declared) && declared >= 0 && declared <= 2 * RANGE_CHUNK ? new Uint8Array(declared) : null
    const parts = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      if (buf && got + value.length <= buf.length) buf.set(value, got)
      else {
        if (buf) {
          parts.push(buf.subarray(0, got))
          buf = null
        }
        parts.push(value)
      }
      got += value.length
      counted += value.length
      onBytes?.(value.length)
    }
    let bytes
    if (buf && got === buf.length) bytes = buf
    else {
      if (buf) parts.push(buf.subarray(0, got))
      bytes = new Uint8Array(got)
      let o = 0
      for (const p of parts) {
        bytes.set(p, o)
        o += p.length
      }
    }
    if (Number.isFinite(declared) && declared !== bytes.length) throw new Error('truncated')
    return { status: res.status, headers: res.headers, bytes }
  } catch (e) {
    onBytes?.(-counted) // this attempt is thrown away: take its bytes off the progress again
    counted = 0
    if (signal.aborted) throw abortError()
    if (stalled) throw new Error('stalled')
    throw e
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// One chunk of one file: [start, start + RANGE_CHUNK). Handles link re-minting (once), retries of
// transient failures (network, 5xx, 429, truncated answers) and maps the rest to FileError.
// -> { bytes, total, start }   (total = whole file size, from Content-Range)
async function getChunk({ file, start, urls, fetchFn, signal, onBytes }) {
  let reminted = false
  let attempt = 0
  let force = false
  for (;;) {
    if (signal.aborted) throw abortError()
    const url = await urls.get(file, { force })
    force = false
    const range = `bytes=${start}-${start + RANGE_CHUNK - 1}`
    let r
    try {
      r = await requestBytes({ url, range, fetchFn, signal, onBytes })
    } catch (e) {
      if (isAbort(e)) throw e
      // network drop / stall / truncated body
      if (++attempt >= MAX_ATTEMPTS) throw new FileError('ดาวน์โหลดไฟล์ไม่สำเร็จ (การเชื่อมต่อขัดข้อง)', 'network')
      await sleep(RETRY_DELAY_MS * attempt, signal)
      continue
    }
    if (r.status === 206 || r.status === 200) {
      const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(r.headers.get('content-range') || '')
      if (r.status === 206 && cr) {
        const s = Number(cr[1])
        const e = Number(cr[2])
        const total = cr[3] === '*' ? null : Number(cr[3])
        if (s !== start || e - s + 1 !== r.bytes.length || total === null) {
          if (++attempt >= MAX_ATTEMPTS) throw new FileError('ได้รับข้อมูลไฟล์ไม่ครบ', 'bad_range')
          onBytes?.(-r.bytes.length)
          continue
        }
        return { bytes: r.bytes, total, start }
      }
      if (r.status === 200 && start === 0) return { bytes: r.bytes, total: r.bytes.length, start } // range ignored: the whole file
      throw new FileError('เซิร์ฟเวอร์ตอบข้อมูลไฟล์ผิดรูปแบบ', 'bad_response')
    }
    if (r.status === 403 && r.error === 'link_expired') {
      if (reminted) throw new FileError('ลิงก์ไฟล์หมดอายุ', 'link_expired')
      reminted = true
      force = true
      continue
    }
    if (r.status === 416 && start === 0) {
      // an empty file cannot satisfy a range: ask without one
      const whole = await requestBytes({ url, range: null, fetchFn, signal, onBytes }).catch((e) => {
        if (isAbort(e)) throw e
        return null
      })
      if (whole && whole.status === 200 && whole.bytes.length === 0) return { bytes: whole.bytes, total: 0, start }
      throw new FileError('อ่านไฟล์ไม่ได้', 'bad_range')
    }
    if (r.status === 404) throw new FileError('ไม่พบไฟล์ในที่เก็บข้อมูล', 'not_found')
    if (r.status === 403) throw new FileError('ไม่มีสิทธิ์เปิดไฟล์นี้', 'forbidden')
    if (r.status === 429 || r.status >= 500) {
      if (++attempt >= MAX_ATTEMPTS) throw new FileError('ที่เก็บไฟล์ไม่ตอบสนอง กรุณาลองใหม่ภายหลัง', 'upstream_error')
      await sleep(RETRY_DELAY_MS * attempt * 2, signal)
      continue
    }
    throw new FileError(`อ่านไฟล์ไม่ได้ (${r.status})`, 'http_' + r.status)
  }
}

// ---- the run ---------------------------------------------------------------------------------------------
// Returns (never throws):
//   { status: 'done' | 'cancelled' | 'failed', ok, okIds, failed: [{ id, name, reason }], bytes, zipName,
//     mode: 'disk' | 'blob', message? }
//   'done'   -> the zip was written / handed to the browser (>= 1 file in it); `failed` lists the files left out
//   'failed' -> nothing was saved (message says why)
//   'cancelled' -> the person cancelled (or closed the save dialog); nothing was saved
export async function runZipDownload({
  files,
  zipName,
  target, // result of pickSaveTarget(zipName): Promise<handle> | null
  signal,
  onProgress,
  getUrls, // (ids, {signal}) => Promise<{ [id]: absoluteUrl }>
  fetchFn = (...a) => fetch(...a),
  loadZip = () => import('client-zip'),
  save = saveBlob,
}) {
  const plan = planZip(files)
  const total = plan.count
  const failed = []
  const okIds = []
  let bytesDone = 0
  let current = 0
  let currentName = ''
  const emit = () =>
    onProgress?.({ index: current, total, name: currentName, bytes: bytesDone, estimate: plan.totalBytes, ok: okIds.length, failed: failed.length })
  let disk = false
  const result = (status, extra = {}) => ({ status, ok: okIds.length, okIds, failed, bytes: bytesDone, zipName, mode: disk ? 'disk' : 'blob', ...extra })

  try {
    if (total === 0) return result('failed', { message: 'ไม่มีไฟล์ให้รวม' })

    // 1. where does it go
    let handle = null
    if (target) {
      try {
        handle = await raceAbort(target, signal)
      } catch (e) {
        if (signal.aborted) return result('cancelled') // Cancel while the save dialog was open
        if (isAbort(e)) return result('cancelled', { silent: true }) // closed the save dialog
        handle = null // SecurityError etc.: fall back to the in-memory way (below) if the size allows
      }
    }
    if (signal.aborted) return result('cancelled')
    disk = !!handle
    if (!disk && plan.overCap) {
      return result('failed', { message: blobCapMessage(plan.totalBytes, plan.capBytes) })
    }
    const mode = disk ? 'disk' : 'blob'

    const { makeZip } = await raceAbort(loadZip(), signal)
    if (signal.aborted) return result('cancelled')

    const urls = makeUrlBook(plan.files, getUrls, signal)
    const nameOf = makeUniqueNamer()
    const onBytes = (n) => {
      bytesDone = Math.max(0, bytesDone + n)
      emit()
    }

    async function* entries() {
      for (let i = 0; i < plan.files.length; i++) {
        const file = plan.files[i]
        if (signal.aborted) throw abortError()
        current = i + 1
        currentName = file.name || ''
        emit()
        let first
        try {
          first = await getChunk({ file, start: 0, urls, fetchFn, signal, onBytes })
        } catch (e) {
          if (e instanceof FileError) {
            failed.push({ id: file.id, name: file.name ? safeEntryName(file.name) : '(ไม่มีชื่อ)', reason: e.message })
            emit()
            continue
          }
          throw e
        }
        const entry = {
          name: nameOf(file.name),
          lastModified: file.date && !Number.isNaN(new Date(file.date).getTime()) ? new Date(file.date) : new Date(),
        }
        if (first.total <= first.bytes.length) {
          entry.input = first.bytes
        } else {
          // more than one chunk: stream the rest. A failure from here on cannot be skipped (bytes are
          // already in the archive) - it ends the whole run with the file's name.
          entry.size = first.total
          entry.input = chunkStream({ file, first, urls, fetchFn, signal, onBytes })
        }
        if (!disk && bytesDone > plan.capBytes * 1.05) {
          throw new FatalError(blobCapMessage(bytesDone, plan.capBytes), 'too_big')
        }
        yield entry
        okIds.push(file.id)
        emit()
      }
      if (okIds.length === 0) throw new FatalError('ไม่สามารถรวมไฟล์ได้เลย — ไม่ได้สร้างไฟล์ Zip', 'nothing')
    }

    const zipStream = makeZip(entries(), { buffersAreUTF8: true })

    // 2. write it
    if (disk) {
      const opening = Promise.resolve(handle.createWritable())
      let writable
      try {
        writable = await raceAbort(opening, signal)
      } catch (e) {
        opening.then((w) => w.abort()).catch(() => {}) // opened after Cancel: throw it away uncommitted
        throw e
      }
      await raceAbort(zipStream.pipeTo(writable, { signal }), signal)
    } else {
      const blobs = [] // groups of ~8 MB, each already a Blob: the final Blob only references them
      let pending = []
      let pendingSize = 0
      let size = 0
      const reader = zipStream.getReader()
      try {
        for (;;) {
          const { done, value } = await raceAbort(reader.read(), signal)
          if (done) break
          pending.push(value)
          pendingSize += value.length
          size += value.length
          if (pendingSize >= 8 * 1024 * 1024) {
            blobs.push(new Blob(pending))
            pending = []
            pendingSize = 0
          }
          if (size > plan.capBytes * 1.1) throw new FatalError(blobCapMessage(size, plan.capBytes), 'too_big')
        }
      } catch (e) {
        try { await reader.cancel() } catch (_) { /* ignore */ }
        throw e
      }
      if (signal.aborted) throw abortError()
      if (pending.length) blobs.push(new Blob(pending))
      save(new Blob(blobs, { type: 'application/zip' }), zipName)
    }
    return result('done', { mode })
  } catch (e) {
    if (signal.aborted || isAbort(e)) return result('cancelled')
    if (e instanceof FatalError) return result('failed', { message: e.message, code: e.code })
    if (e instanceof FileError) {
      // a later chunk of a big file failed after the archive had started: nothing usable is left
      return result('failed', { message: e.message, code: e.code })
    }
    console.warn('zip download failed:', e?.name)
    return result('failed', {
      message: disk
        ? 'บันทึกไฟล์ Zip ลงเครื่องไม่สำเร็จ (พื้นที่ว่างอาจไม่พอ หรือไม่มีสิทธิ์เขียนไฟล์ที่เลือก) กรุณาลองใหม่อีกครั้ง'
        : 'สร้างไฟล์ Zip ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      code: 'unknown',
    })
  }
}

// the rest of a big file, one range request per pull (so the stream is read as fast as the zip is written)
function chunkStream({ file, first, urls, fetchFn, signal, onBytes }) {
  let next = first.bytes.length
  let sent = false
  return new ReadableStream({
    async pull(controller) {
      try {
        if (!sent) {
          sent = true
          controller.enqueue(first.bytes)
          return
        }
        if (next >= first.total) {
          controller.close()
          return
        }
        const c = await getChunk({ file, start: next, urls, fetchFn, signal, onBytes })
        if (c.bytes.length === 0 || c.total !== first.total) throw new FileError('ไฟล์ถูกเปลี่ยนระหว่างดาวน์โหลด', 'changed')
        next += c.bytes.length
        controller.enqueue(c.bytes)
      } catch (e) {
        if (e instanceof FileError) {
          controller.error(new FileError(`ไฟล์ "${file.name}" ดาวน์โหลดไม่ครบ: ${e.message}`, e.code))
        } else controller.error(e)
      }
    },
  })
}

export function blobCapMessage(bytes, cap = blobCapBytes()) {
  const mobile = cap === ZIP_BLOB_CAP_MOBILE_BYTES
  return (
    `ไฟล์ที่เลือกมีขนาดรวมประมาณ ${fmtBytes(bytes)} ซึ่งใหญ่เกินกว่าที่เบราว์เซอร์นี้จะรวมเป็น Zip ได้ ` +
    `(สูงสุด ${fmtBytes(cap)}${mobile ? ' บนมือถือ/แท็บเล็ต' : ''}) — กรุณาเลือกไฟล์ให้น้อยลง หรือใช้ Chrome / Edge บนคอมพิวเตอร์ ซึ่งบันทึก Zip ขนาดใหญ่ลงเครื่องได้โดยตรง`
  )
}

// hand a Blob to the browser as a download
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
