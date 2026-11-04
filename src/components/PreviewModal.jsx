import { useState, useEffect, useRef } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { getSignedFileUrl, fetchFileResponse, downloadFile } from '../api/supabase.js'
import { fmtSize, fmtDate, TYPE_LABEL, TYPE_COLOR } from '../utils/format.js'

// Detect file category from extension
function getFileCategory(ext) {
  const e = (ext || '').toLowerCase()
  if (e === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(e)) return 'image'
  if (['docx', 'doc'].includes(e)) return 'word'
  if (['xlsx', 'xls', 'csv'].includes(e)) return 'excel'
  if (['pptx', 'ppt'].includes(e)) return 'powerpoint'
  if (['txt', 'md', 'json', 'log', 'xml', 'html'].includes(e)) return 'text'
  if (['mp4', 'webm', 'mov'].includes(e)) return 'video'
  if (['mp3', 'wav', 'ogg'].includes(e)) return 'audio'
  return 'unknown'
}

// Categories shown through a signed URL (iframe / img / video / audio / Office viewer).
// Plain text is fetched as bytes, anything else shows extracted text or a download prompt.
const EMBED_CATEGORIES = ['pdf', 'image', 'word', 'excel', 'powerpoint', 'video', 'audio']

export default function PreviewModal({ file, onClose }) {
  const [textContent, setTextContent] = useState('')
  const [loadingText, setLoadingText] = useState(false)
  const [loadError, setLoadError] = useState(null)
  // Signed, short-lived URL from POST /api/drive-url (the server checks the person may see this file)
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState('')
  const [urlTick, setUrlTick] = useState(0)
  const reminted = useRef(false)
  const toast = useToast()

  const ext = (file.ext || file.name?.split('.').pop() || '').toLowerCase()
  const category = getFileCategory(ext)
  const needsUrl = EMBED_CATEGORIES.includes(category)
  const typeColor = TYPE_COLOR[file.type] || '#6B7280'
  const typeLabel = TYPE_LABEL[file.type] || file.type

  useEffect(() => {
    if (!needsUrl) return undefined
    let alive = true
    setUrl('')
    setUrlError('')
    getSignedFileUrl(file.id)
      .then((u) => alive && setUrl(u))
      .catch((err) => alive && setUrlError(err?.message || 'เปิดไฟล์ไม่สำเร็จ'))
    return () => {
      alive = false
    }
  }, [file.id, needsUrl, urlTick])

  // A link lives ~5 minutes. If media stops loading because it expired, ask for a new one (once).
  const handleMediaError = () => {
    if (reminted.current) return
    reminted.current = true
    setUrlTick((n) => n + 1)
  }

  useEffect(() => {
    // Load text content for plain text files
    if (category !== 'text') return undefined
    let alive = true
    setLoadingText(true)
    setLoadError(null)
    fetchFileResponse(file.id)
      .then((r) => {
        if (!r.ok) throw new Error('โหลดไฟล์ไม่สำเร็จ')
        return r.text()
      })
      .then((t) => {
        if (!alive) return
        // Strip BOM if present
        const cleaned = t.replace(/^\uFEFF/, '')
        setTextContent(cleaned.slice(0, 200000)) // limit 200KB
        setLoadingText(false)
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(err.message || 'โหลดไฟล์ไม่สำเร็จ')
        setLoadingText(false)
      })
    return () => {
      alive = false
    }
  }, [file.id, category])

  const handleDownload = async () => {
    try {
      await downloadFile(file.id, file.name)
      toast(`ดาวน์โหลด ${file.name}`)
    } catch (err) {
      toast(err?.message || 'ดาวน์โหลดไม่สำเร็จ', 'err')
    }
  }

  // Always a fresh link (the one in the viewer may be old). The tab is opened first so the
  // browser does not treat it as a pop-up, then pointed at the file.
  const handleOpenNewTab = async () => {
    const w = window.open('about:blank', '_blank')
    try {
      const u = await getSignedFileUrl(file.id)
      if (w) {
        w.opener = null
        w.location.href = u
      } else {
        window.location.assign(u)
      }
    } catch (err) {
      if (w) w.close()
      toast(err?.message || 'เปิดไฟล์ไม่สำเร็จ', 'err')
    }
  }

  // Render preview content based on category
  let previewContent
  const waitingForUrl = needsUrl && !url
  switch (waitingForUrl ? 'waiting' : category) {
    case 'waiting':
      previewContent = urlError ? (
        <div className="preview-center" role="alert">
          <Icon name="alert" size={32} style={{ color: 'var(--red)' }} />
          <div style={{ marginTop: 12, color: 'var(--red)', textAlign: 'center', maxWidth: 360 }}>{urlError}</div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={() => setUrlTick((n) => n + 1)}>
            <Icon name="refresh" size={14} /> ลองอีกครั้ง
          </button>
        </div>
      ) : (
        <div className="preview-center">
          <div className="spinner"></div>
          <div style={{ marginTop: 12, color: 'var(--gray-500)' }}>กำลังเตรียมไฟล์...</div>
        </div>
      )
      break

    case 'pdf':
      previewContent = (
        <iframe
          src={url + '#toolbar=1&navpanes=1'}
          title={file.name}
          style={{ width: '100%', height: '100%', border: 'none', background: '#525659' }}
        />
      )
      break

    case 'image':
      previewContent = (
        <div className="preview-image-wrap">
          <img src={url} alt={file.name} onError={handleMediaError} />
        </div>
      )
      break

    case 'word':
    case 'excel':
    case 'powerpoint': {
      // Microsoft Office Online viewer
      const officeUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`
      previewContent = (
        <div style={{ width: '100%', height: '100%', position: 'relative', background: '#f4f4f4' }}>
          <iframe
            src={officeUrl}
            title={file.name}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
          {file.contentText && (
            <div
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                padding: '4px 10px',
                background: 'rgba(31,58,95,0.9)',
                color: 'white',
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              📄 Powered by Office Online
            </div>
          )}
        </div>
      )
      break
    }

    case 'text':
      if (loadingText) {
        previewContent = (
          <div className="preview-center">
            <div className="spinner"></div>
            <div style={{ marginTop: 12, color: 'var(--gray-500)' }}>กำลังโหลด...</div>
          </div>
        )
      } else if (loadError) {
        previewContent = (
          <div className="preview-center">
            <Icon name="close" size={32} style={{ color: 'var(--red)' }} />
            <div style={{ marginTop: 12, color: 'var(--red)' }}>{loadError}</div>
          </div>
        )
      } else {
        previewContent = (
          <pre
            style={{
              padding: 24,
              margin: 0,
              height: '100%',
              overflow: 'auto',
              background: 'white',
              fontFamily: '"Courier New", monospace',
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--gray-900)',
            }}
          >
            {textContent || '(ไฟล์ว่าง)'}
          </pre>
        )
      }
      break

    case 'video':
      previewContent = (
        <div className="preview-center" style={{ background: '#000' }}>
          <video src={url} controls onError={handleMediaError} style={{ maxWidth: '100%', maxHeight: '100%' }}>
            ไม่รองรับการเล่นวิดีโอใน browser นี้
          </video>
        </div>
      )
      break

    case 'audio':
      previewContent = (
        <div className="preview-center">
          <Icon name="file" size={48} style={{ color: 'var(--steel)' }} />
          <div style={{ marginTop: 16, fontSize: 14, color: 'var(--gray-700)' }}>{file.name}</div>
          <audio src={url} controls onError={handleMediaError} style={{ marginTop: 16 }}>
            ไม่รองรับการเล่นเสียงใน browser นี้
          </audio>
        </div>
      )
      break

    default:
      // Unknown format — show extracted text if available, else show "no preview"
      if (file.contentText && file.contentText.length > 10) {
        previewContent = (
          <div style={{ padding: 24, height: '100%', overflow: 'auto', background: 'white' }}>
            <div
              style={{
                background: 'var(--steel-50)',
                padding: 12,
                borderRadius: 8,
                marginBottom: 16,
                fontSize: 12,
                color: 'var(--steel)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name="sparkles" size={14} />
              ระบบไม่รองรับการ Preview ไฟล์ .{ext} โดยตรง — แสดงข้อความที่สกัดได้แทน
            </div>
            <pre
              style={{
                fontFamily: 'inherit',
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                margin: 0,
                color: 'var(--gray-900)',
              }}
            >
              {file.contentText}
            </pre>
          </div>
        )
      } else {
        previewContent = (
          <div className="preview-center" style={{ padding: 40, textAlign: 'center' }}>
            <div
              style={{
                width: 64,
                height: 64,
                background: typeColor,
                borderRadius: 16,
                display: 'grid',
                placeItems: 'center',
                color: 'white',
                fontFamily: 'Prompt',
                fontWeight: 600,
                fontSize: 18,
                marginBottom: 16,
              }}
            >
              {typeLabel.slice(0, 3)}
            </div>
            <h3 style={{ marginTop: 8, color: 'var(--navy)' }}>ไม่รองรับการ Preview</h3>
            <p style={{ fontSize: 13, color: 'var(--gray-500)', maxWidth: 360, marginTop: 8 }}>
              ไฟล์ประเภท <code>.{ext}</code> ยังไม่รองรับการแสดงตัวอย่างใน browser
              <br />
              กรุณาดาวน์โหลดเพื่อเปิดด้วยโปรแกรมที่เหมาะสม
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" onClick={handleDownload}>
                <Icon name="download" size={14} /> ดาวน์โหลด
              </button>
              <button className="btn btn-ghost" onClick={handleOpenNewTab}>
                <Icon name="arrow-r" size={14} /> เปิดในแท็บใหม่
              </button>
            </div>
          </div>
        )
      }
  }

  return (
    <div className="preview-backdrop" onClick={onClose}>
      <div className="preview-modal" role="dialog" aria-modal="true" aria-label={file.name} onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: typeColor,
                color: 'white',
                display: 'grid',
                placeItems: 'center',
                fontFamily: 'Prompt',
                fontWeight: 600,
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              {typeLabel.slice(0, 3)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="preview-title" title={file.name}>
                {file.name}
              </div>
              <div className="preview-meta">
                {typeLabel} · {fmtSize(file.size)} · {fmtDate(file.date)}
                {file.uploader && ` · ${file.uploader}`}
                {file.isLatest && (
                  <span className="badge badge-latest" style={{ marginLeft: 6 }}>
                    ล่าสุด
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="preview-actions">
            <button className="btn btn-ghost btn-sm" onClick={handleOpenNewTab} title="เปิดในแท็บใหม่">
              <Icon name="arrow-r" size={14} />
              <span className="preview-action-label">แท็บใหม่</span>
            </button>
            <button className="btn btn-navy btn-sm" onClick={handleDownload}>
              <Icon name="download" size={14} />
              <span className="preview-action-label">ดาวน์โหลด</span>
            </button>
            <button className="icon-btn" onClick={onClose} title="ปิด">
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
        <div className="preview-body">{previewContent}</div>
      </div>
    </div>
  )
}
