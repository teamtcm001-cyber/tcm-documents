// Client-side text extraction from PDF / DOCX / XLSX / TXT
// Used for content-based search in AI Smart Search

const MAX_TEXT_LENGTH = 50000 // limit storage per file (50KB text)

// OCR (scanned PDFs / photos) lives in its own lazily-loaded module: only an upload / re-index that
// really needs it downloads the engine. Opt-in per call: extractTextDetailed(file, name, { ocr: true }).
const loadOcr = () => import('./ocr.js')
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp']

// PDF.js setup using CDN worker (more reliable across builds)
let pdfjsInstance = null
export async function getPDFJS() {
  if (pdfjsInstance) return pdfjsInstance
  const pdfjs = await import('pdfjs-dist')
  try {
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
    }
  } catch (e) {
    console.warn('Failed to set PDF worker URL:', e)
  }
  pdfjsInstance = pdfjs
  return pdfjs
}

const RESULT = {
  SUCCESS: 'success',
  EMPTY: 'empty',
  UNSUPPORTED: 'unsupported',
  ERROR: 'error',
}

// Extract from PDF using pdfjs with robust options.
// No usable text layer (a scanned PDF) + opts.ocr -> OCR the pages; returns { text, ocr } then.
async function extractFromPDF(file, opts = {}) {
  const pdfjs = await getPDFJS()
  const arrayBuffer = await file.arrayBuffer()

  if (arrayBuffer.byteLength === 0) {
    throw new Error('ไฟล์ว่างเปล่า (0 bytes)')
  }

  // Check PDF magic bytes
  const sig = new Uint8Array(arrayBuffer, 0, 5)
  if (!(sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46)) {
    throw new Error('ไฟล์ไม่ใช่ PDF มาตรฐาน (ไม่มี %PDF header)')
  }

  // Use robust loading options for problematic PDFs
  const loadingTask = pdfjs.getDocument({
    data: arrayBuffer,
    // Use CDN cMaps for non-Latin character maps (Thai, special chars)
    cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
    useSystemFonts: true,
    isEvalSupported: false, // safer
    disableFontFace: false,
    verbosity: 0, // suppress warnings
  })

  const pdf = await loadingTask.promise
  const numPages = Math.min(pdf.numPages, 200)

  let fullText = ''
  let extractedPages = 0
  let pagesRead = 0
  for (let i = 1; i <= numPages; i++) {
    pagesRead = i
    try {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      })
      const pageText = content.items
        .filter((it) => it.str)
        .map((it) => it.str)
        .join(' ')
      if (pageText.trim()) {
        fullText += pageText + '\n'
        extractedPages++
      }
      if (fullText.length >= MAX_TEXT_LENGTH) break
    } catch (pageErr) {
      console.warn(`PDF page ${i} extraction failed:`, pageErr.message)
      // Continue with next page (don't fail whole document)
    }
  }

  const layerText = fullText.slice(0, MAX_TEXT_LENGTH).trim()
  try {
    // A real text layer is always better than OCR (OCR would only re-read a picture of the same text):
    // OCR only a scan = under 20 text characters per page on average (a scan may carry a digital
    // footer / stamp like "Page 1/30", a real text PDF has far more).
    const perPage = layerText.replace(/\s/g, '').length / Math.max(1, pagesRead)
    if (opts.ocr && perPage < 20) {
      const { ocrDocument } = await loadOcr()
      const r = await ocrDocument(file, file.name || '', { pdf, onProgress: opts.onOcrProgress, signal: opts.signal })
      // keep the PDF's own (exact) text too: captions / stamps / pages past the OCR page limit
      if (r.status === 'success') {
        const text = layerText ? `${r.text}\n\n[[TEXT]]\n${layerText}`.slice(0, MAX_TEXT_LENGTH) : r.text
        return { text, ocr: r }
      }
      // OCR found nothing or failed: the little real text the PDF has is still better than nothing
      if (layerText.length >= 5) return { text: layerText, ocr: null }
      return { text: '', ocr: r }
    }
  } finally {
    // Cleanup
    try {
      await pdf.destroy()
    } catch (_) {}
  }

  // If 0 pages extracted, return empty string (caller will mark as EMPTY, not ERROR)
  // This handles scanned PDFs gracefully
  return layerText
}

// Extract from DOCX with format validation + plain text fallback
async function extractFromDOCX(file) {
  const arrayBuffer = await file.arrayBuffer()

  if (arrayBuffer.byteLength === 0) {
    throw new Error('ไฟล์ว่างเปล่า (0 bytes)')
  }

  const sig = new Uint8Array(arrayBuffer, 0, 4)

  // Valid DOCX (ZIP container starting with "PK")
  if (sig[0] === 0x50 && sig[1] === 0x4b) {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ arrayBuffer })
    const text = (result.value || '').trim()
    if (result.messages && result.messages.length > 0) {
      console.log('Mammoth warnings:', result.messages)
    }
    return text.slice(0, MAX_TEXT_LENGTH)
  }

  // Old .doc (OLE compound document)
  if (sig[0] === 0xd0 && sig[1] === 0xcf && sig[2] === 0x11 && sig[3] === 0xe0) {
    throw new Error('ไฟล์เป็น .doc รูปแบบเก่า (Word 97-2003) — กรุณาเปิดด้วย Word แล้ว "Save As" เป็น .docx แล้ว Upload ใหม่')
  }

  // UTF-8 BOM (EF BB BF) → file is actually plain text saved with .docx extension
  if (sig[0] === 0xef && sig[1] === 0xbb && sig[2] === 0xbf) {
    console.log('File has UTF-8 BOM, extracting as plain text:', file.name)
    const decoder = new TextDecoder('utf-8')
    const text = decoder.decode(arrayBuffer).replace(/^﻿/, '').trim()
    return text.slice(0, MAX_TEXT_LENGTH)
  }

  // UTF-16 LE BOM (FF FE) or UTF-16 BE BOM (FE FF)
  if ((sig[0] === 0xff && sig[1] === 0xfe) || (sig[0] === 0xfe && sig[1] === 0xff)) {
    console.log('File has UTF-16 BOM, extracting as text:', file.name)
    const enc = sig[0] === 0xff ? 'utf-16le' : 'utf-16be'
    const decoder = new TextDecoder(enc)
    const text = decoder.decode(arrayBuffer).replace(/^﻿/, '').trim()
    return text.slice(0, MAX_TEXT_LENGTH)
  }

  // RTF
  const head = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, Math.min(10, arrayBuffer.byteLength)))
  if (head.startsWith('{\\rtf')) {
    throw new Error('ไฟล์เป็น RTF — กรุณา Save As เป็น .docx ใน Word')
  }

  // Last resort: try reading as plain text (ASCII / Latin1)
  // Many files with .docx extension might actually be text files
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const text = decoder.decode(arrayBuffer).trim()
    // Check if it looks like reasonable text (printable chars > 80%)
    const printable = text.match(/[\x20-\x7E฀-๿ -￿\n\r\t]/g) || []
    if (text.length > 0 && printable.length / text.length > 0.85) {
      console.log('Extracted as plain text:', file.name)
      return text.slice(0, MAX_TEXT_LENGTH)
    }
  } catch (_) {}

  throw new Error(`ไฟล์ไม่ใช่ .docx มาตรฐาน (signature: ${Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join(' ')}) — อาจเป็น binary format ที่ไม่รองรับ`)
}

// Extract from XLSX with format validation
async function extractFromXLSX(file) {
  const arrayBuffer = await file.arrayBuffer()

  if (arrayBuffer.byteLength === 0) {
    throw new Error('ไฟล์ว่างเปล่า (0 bytes)')
  }

  const XLSX = await import('xlsx')
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })

  let text = ''
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    if (csv && csv.trim()) {
      text += `[${sheetName}]\n${csv}\n\n`
    }
    if (text.length >= MAX_TEXT_LENGTH) break
  }
  return text.slice(0, MAX_TEXT_LENGTH).trim()
}

// Extract from plain text
async function extractFromText(file) {
  const text = await file.text()
  return text.slice(0, MAX_TEXT_LENGTH).trim()
}

/**
 * Main extraction function — returns detailed result
 */
export async function extractTextDetailed(file, filename, opts = {}) {
  if (!file) return { status: RESULT.ERROR, text: '', error: 'No file provided' }
  const name = (filename || file.name || '').toLowerCase()
  const ext = name.split('.').pop()

  try {
    let text = ''
    let ocr = null // the OCR result, when OCR ran
    switch (ext) {
      case 'pdf': {
        const r = await extractFromPDF(file, opts)
        if (typeof r === 'string') text = r
        else ({ text, ocr } = r)
        break
      }
      case 'docx':
        text = await extractFromDOCX(file)
        break
      case 'doc':
        throw new Error('.doc รูปแบบเก่า (Word 97-2003) ไม่รองรับ — กรุณา Save As เป็น .docx')
      case 'xlsx':
      case 'xls':
        text = await extractFromXLSX(file)
        break
      case 'csv':
      case 'txt':
      case 'md':
      case 'json':
        text = await extractFromText(file)
        break
      default:
        if (opts.ocr && IMAGE_EXT.includes(ext)) {
          const { ocrDocument } = await loadOcr()
          ocr = await ocrDocument(file, name, { onProgress: opts.onOcrProgress, signal: opts.signal })
          text = ocr.status === 'success' ? ocr.text : ''
          break
        }
        return { status: RESULT.UNSUPPORTED, text: '', error: `รูปแบบ .${ext} ยังไม่รองรับ` }
    }

    if (ocr && (ocr.status === 'error' || ocr.status === 'aborted')) {
      return { status: RESULT.ERROR, text: '', error: ocr.error, ocr: true }
    }
    // OCR ran fine and found no text (site photo, logo): EMPTY, but `storeText` (a short OCR marker) is worth
    // saving so the next re-index does not OCR the same file again
    if (ocr && ocr.status === 'empty') {
      return { status: RESULT.EMPTY, text: '', storeText: ocr.text, error: ocr.error || 'ไม่พบข้อความในภาพ (OCR)', ocr: true }
    }
    if (!text || text.length < 5) {
      return {
        status: RESULT.EMPTY,
        text: '',
        error: ocr ? ocr.error || 'ไม่พบข้อความในภาพ (OCR)' : ext === 'pdf' ? 'PDF อาจเป็นภาพสแกน (ไม่มี text layer) — ต้อง OCR ก่อน' : 'ไม่พบข้อความในไฟล์',
        ocr: !!ocr,
      }
    }
    return { status: RESULT.SUCCESS, text, error: null, ocr: !!ocr, ocrPages: ocr?.pages, ocrPagesTotal: ocr?.pagesTotal }
  } catch (err) {
    console.error('Extract text error:', filename, err)
    return {
      status: RESULT.ERROR,
      text: '',
      error: err?.message || String(err),
    }
  }
}

export async function extractText(file, filename, opts) {
  const result = await extractTextDetailed(file, filename, opts)
  return result.text
}

export async function extractTextFromBlob(blob, filename, opts) {
  return extractText(blob, filename, opts)
}

export async function extractTextFromBlobDetailed(blob, filename, opts) {
  return extractTextDetailed(blob, filename, opts)
}

// File names whose text can be extracted (re-index); images only with OCR.
export const EXTRACTABLE_RE = /\.(pdf|docx?|xlsx?|txt|md|csv|json|jpe?g|png|webp|bmp)$/i

export function findSnippet(text, keyword, contextLen = 60) {
  if (!text || !keyword) return ''
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (idx < 0) return ''
  const start = Math.max(0, idx - contextLen)
  const end = Math.min(text.length, idx + keyword.length + contextLen)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'
  return snippet.replace(/\s+/g, ' ').trim()
}

export { RESULT }
