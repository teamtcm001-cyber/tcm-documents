// Free, client-side OCR (tesseract.js, Apache-2.0) for scanned PDFs and photos, so their text can be
// stored in files.content_text and found by search / the AI chat. Nothing leaves the browser: the
// engine, its WebAssembly core and the Thai + English language data are fetched once from the
// jsdelivr CDN (version-pinned by tesseract.js) and cached by the browser.
//
// Rules (see CLAUDE.md "OCR"):
// - a PDF is OCR'd ONLY when it has no usable text layer (textExtract.js decides; OCR on a real text
//   layer would only make the text worse)
// - at most OCR_MAX_PAGES pages per file; the engine start, every page and the whole file have time limits
// - ONE job at a time (a queue): two jobs on the shared worker would eat each other's time limits
// - OCR text starts with OCR_MARK; pages are marked "[[p.N]]" - short tags that ordinary searches never hit
// - one shared worker, terminated after OCR_IDLE_MS of inactivity (frees ~100 MB) or after a timeout

export const OCR_MARK = '[[OCR]]'
export const OCR_MAX_PAGES = 20
export const OCR_NO_TEXT = `${OCR_MARK} (ไม่พบข้อความในภาพ)` // stored when OCR ran fine but found nothing: no re-OCR on every re-index
const OCR_START_TIMEOUT_MS = 120_000 // engine + language data download (slow phone connection)
const OCR_PAGE_TIMEOUT_MS = 90_000
const OCR_FILE_TIMEOUT_MS = 10 * 60_000
const OCR_IDLE_MS = 60_000
const OCR_LANGS = 'tha+eng'
const MIN_IMAGE_WIDTH = 1600 // small photos are upscaled before OCR
const MAX_CANVAS_PIXELS = 6_000_000 // keep phones (iOS kills big tabs) from running out of memory
const MAX_SIDE = 2600 // longest side of a page image
const MAX_TEXT_LENGTH = 50000 // same cap as textExtract.js

export const OCR_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp']
export const isOcrImage = (name) => OCR_IMAGE_EXT.includes(String(name || '').toLowerCase().split('.').pop())
export const isOcrText = (text) => typeof text === 'string' && text.startsWith(OCR_MARK)

class OcrTimeout extends Error {}
class OcrAborted extends Error {}

function withTimeout(promise, ms, signal) {
  // the raced job may still fail AFTER we gave up on it (e.g. tesseract posting to a worker we just terminated):
  // that late rejection is expected - never let it surface as an unhandled rejection
  promise.catch(() => {})
  let t
  let onAbort
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new OcrTimeout('timeout')), ms)
      if (signal) {
        onAbort = () => reject(new OcrAborted('aborted'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    }),
  ]).finally(() => {
    clearTimeout(t)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  })
}

// ---------- worker lifecycle ----------
let workerPromise = null
let idleTimer = null
let queue = Promise.resolve() // jobs run one after another

function getWorker() {
  clearTimeout(idleTimer)
  if (!workerPromise) {
    const p = (async () => {
      const { createWorker } = await import('tesseract.js')
      try {
        return await createWorker(OCR_LANGS, 1 /* LSTM only */, { logger: () => {} })
      } catch (err) {
        // IndexedDB (language-data cache) can be unavailable, e.g. in a private window: retry without the cache
        return createWorker(OCR_LANGS, 1, { logger: () => {}, cacheMethod: 'none' })
      }
    })()
    workerPromise = p
    // a failed start must not stay cached (but never clear a newer worker that replaced it meanwhile)
    p.catch(() => {
      if (workerPromise === p) workerPromise = null
    })
  }
  return workerPromise
}

// The last recognize() handed to the worker. tesseract.js first prepares the image (async) and only then
// posts the job: terminating the worker in between makes tesseract post to a dead worker inside a promise
// nobody can catch (an unhandled rejection). So a worker that may still be preparing an abandoned page is
// terminated once that job settled, or after KILL_GRACE_MS (image preparation takes milliseconds).
let inflight = null
const KILL_GRACE_MS = 5000

// Throw the worker away (after a timeout / abort it may still be busy with an abandoned page). New jobs
// get a fresh worker at once; a worker still starting is terminated once it is up.
function killWorker() {
  clearTimeout(idleTimer)
  const p = workerPromise
  workerPromise = null
  if (!p) return
  const job = inflight
  inflight = null
  const settled = job
    ? Promise.race([job.then(() => {}, () => {}), new Promise((r) => setTimeout(r, KILL_GRACE_MS))])
    : Promise.resolve()
  settled
    .then(() => p)
    .then((w) => w.terminate())
    .catch(() => {})
}

function scheduleIdleKill() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(killWorker, OCR_IDLE_MS)
}

// ---------- image preparation ----------
function newCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

// Upscale small images to MIN_IMAGE_WIDTH; stay within MAX_CANVAS_PIXELS and MAX_SIDE.
function fitScale(w, h, wanted) {
  let scale = wanted
  if (w * h * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
  if (Math.max(w, h) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(w, h)
  return scale
}

// Grayscale + mild contrast stretch (no hard threshold: that can erase thin strokes of Thai letters).
function enhance(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const CONTRAST = 1.35
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    let v = (gray - 128) * CONTRAST + 128
    v = v < 0 ? 0 : v > 255 ? 255 : v
    d[i] = d[i + 1] = d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

async function imageToCanvas(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = fitScale(bitmap.width, bitmap.height, bitmap.width < MIN_IMAGE_WIDTH ? MIN_IMAGE_WIDTH / bitmap.width : 1)
    const c = newCanvas(bitmap.width * scale, bitmap.height * scale)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#fff' // transparent PNG -> white paper, not black
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bitmap, 0, 0, c.width, c.height)
    return c
  } finally {
    bitmap.close?.()
  }
}

async function pdfPageToCanvas(page) {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: fitScale(base.width, base.height, 2.8) }) // ~200 dpi for A4
  const c = newCanvas(viewport.width, viewport.height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return c
}

// Thai letters / vowels / tone marks - NOT the Thai digits (๐-๙): "๒ ๑,๕๐๐" must stay two numbers.
const TH = 'ก-๏'
const THAI_GAP = new RegExp(`([${TH}]) (?=[${TH}])`, 'g')

// Tesseract puts spaces between Thai characters / syllables (Thai is written without them). Only a
// SINGLE space between two Thai letters is removed (wider gaps = real spacing are kept); digits are never joined.
// Lines without any letter or digit (specks, table borders read as "|||---") are dropped; anything with a
// letter or digit stays (clause numbers "1.1", quantities "0.5", units "ลบ.ม.", sheet numbers "A-1").
export function tidyOcrText(text) {
  return String(text || '')
    .replace(THAI_GAP, '$1')
    // sara am comes out as nikhahit + sara aa (ํา, also around a tone mark): back to ำ, or "สำนักงาน" is never found
    .replace(/ํ([่-๋]?)า/g, '$1ำ')
    .split('\n')
    .filter((l) => !l.trim() || /[฀-๿A-Za-z0-9]/.test(l))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function recognize(canvas, signal) {
  const worker = await withTimeout(getWorker(), OCR_START_TIMEOUT_MS, signal)
  const job = worker.recognize(canvas)
  inflight = job
  const { data } = await withTimeout(job, OCR_PAGE_TIMEOUT_MS, signal)
  if (inflight === job) inflight = null
  return { text: tidyOcrText(data?.text), confidence: Number(data?.confidence) || 0 }
}

/**
 * OCR one image file or one (already opened) pdf.js document. Jobs are queued: one at a time.
 * @param {Blob} blob            the file bytes
 * @param {string} name          file name (decides image vs PDF)
 * @param {object} opts
 *   - pdf:        an open pdf.js document (PDF only; the caller already loaded it for the text-layer check)
 *   - onProgress: ({ page, pages }) => void
 *   - signal:     AbortSignal (abandons the running page at once; the worker is then replaced)
 * @returns {{ status: 'success'|'empty'|'error'|'aborted', text: string, pages: number, pagesTotal: number,
 *            confidence: number, error: string|null }}
 *   'empty' = OCR ran fine and found no text (text is OCR_NO_TEXT, worth storing); 'error' / 'aborted' = try again later
 */
export function ocrDocument(blob, name, opts = {}) {
  const run = queue.then(() => runOcr(blob, name, opts))
  queue = run.catch(() => {})
  return run
}

async function runOcr(blob, name, { pdf = null, onProgress, signal } = {}) {
  clearTimeout(idleTimer)
  const started = Date.now()
  const texts = []
  const conf = []
  let pagesTotal = 1
  let pagesDone = 0
  const check = () => {
    if (signal?.aborted) throw new OcrAborted('aborted')
    if (Date.now() - started > OCR_FILE_TIMEOUT_MS) throw new OcrTimeout('file timeout')
  }
  const result = (status, text, error = null) => ({
    status,
    text,
    pages: pagesDone,
    pagesTotal,
    confidence: conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length) : 0,
    error,
  })
  try {
    if (pdf) {
      pagesTotal = pdf.numPages
      const pages = Math.min(pdf.numPages, OCR_MAX_PAGES)
      for (let p = 1; p <= pages; p++) {
        check()
        onProgress?.({ page: p, pages })
        const page = await withTimeout(pdf.getPage(p), OCR_PAGE_TIMEOUT_MS, signal)
        const canvas = await withTimeout(pdfPageToCanvas(page), OCR_PAGE_TIMEOUT_MS, signal)
        enhance(canvas)
        check()
        const r = await recognize(canvas, signal)
        canvas.width = canvas.height = 0 // release the bitmap memory now
        page.cleanup?.()
        pagesDone++
        if (r.text) {
          texts.push(pages > 1 ? `[[p.${p}]]\n${r.text}` : r.text)
          conf.push(r.confidence)
        }
        if (texts.join('\n\n').length >= MAX_TEXT_LENGTH) break
      }
    } else {
      check()
      onProgress?.({ page: 1, pages: 1 })
      const canvas = enhance(await withTimeout(imageToCanvas(blob), OCR_PAGE_TIMEOUT_MS, signal))
      const r = await recognize(canvas, signal)
      canvas.width = canvas.height = 0
      pagesDone = 1
      if (r.text) {
        texts.push(r.text)
        conf.push(r.confidence)
      }
    }
    const body = texts.join('\n\n')
    // "text" of a few stray characters (a site photo, a logo) is not worth storing
    if (body.replace(/\s/g, '').length < 10) return result('empty', OCR_NO_TEXT, 'ไม่พบข้อความในภาพ (OCR)')
    const limited = pagesTotal > OCR_MAX_PAGES ? ` [[OCR ${OCR_MAX_PAGES}/${pagesTotal}]]` : ''
    return result('success', `${OCR_MARK}${limited}\n${body}`.slice(0, MAX_TEXT_LENGTH))
  } catch (err) {
    // a timed-out / abandoned page leaves the worker busy: throw it away, the next job starts a fresh one
    if (err instanceof OcrTimeout || err instanceof OcrAborted) killWorker()
    if (err instanceof OcrAborted) return result('aborted', '', 'ยกเลิกการอ่านข้อความ (OCR)')
    // keep what was read before a timeout on a later page
    if (err instanceof OcrTimeout && texts.length) {
      return result('success', `${OCR_MARK} [[OCR ${pagesDone}/${pagesTotal}]]\n${texts.join('\n\n')}`.slice(0, MAX_TEXT_LENGTH))
    }
    const error =
      err instanceof OcrTimeout
        ? 'อ่านข้อความจากภาพ (OCR) นานเกินกำหนด'
        : /fetch|network|load|import/i.test(String(err?.message))
          ? 'โหลดเครื่องมืออ่านข้อความ (OCR) ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'
          : `อ่านข้อความจากภาพ (OCR) ไม่สำเร็จ: ${err?.message || err}`
    return result('error', '', error)
  } finally {
    scheduleIdleKill()
  }
}
