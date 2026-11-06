import { useState, useEffect, useRef } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { fetchProjects, uploadFile, logActivity } from '../api/supabase.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { fmtSize, detectType, detectVersion, TYPE_LABEL, TYPE_COLOR, TYPE_KEYS } from '../utils/format.js'
import { extractText } from '../utils/textExtract.js'

// errors that make every further file in this batch fail too (no access, session over, server unreachable, throttled)
const STOP_CODES = new Set([
  'unauthorized', 'forbidden', 'no_access', 'rate_limited', 'auth_unavailable', 'password_change_required', 'account_disabled', 'unsure_outcome',
])
// NOT in the list on purpose (they only concern the one file, the next one may well work): 'file_too_large',
// 'upstream_error' (Google Drive hiccup), 'network', 'drive'.

// The bar: 0-30 reading the file, 30-70 text extraction, 70-95 the real byte upload to Google Drive, 100 saved.
const UPLOAD_FROM = 70
const UPLOAD_SPAN = 25

export default function UploadModal({ onClose, onUploaded }) {
  const { canEditProject } = useAuth()
  const [projects, setProjects] = useState([])
  const [projId, setProjId] = useState('')
  const [type, setType] = useState('auto')
  const [items, setItems] = useState([])
  const [drag, setDrag] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    // only projects the person may write to (RLS rejects the rest anyway)
    fetchProjects().then((all) => {
      const data = all.filter((p) => canEditProject(p.id))
      setProjects(data)
      if (data.length > 0) setProjId(data[0].id)
    })
  }, [])

  const handleFiles = (fileList) => {
    const arr = Array.from(fileList).map((f) => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      name: f.name,
      size: Math.round(f.size / 1024),
      type: type === 'auto' ? detectType(f.name) : type,
      version: detectVersion(f.name),
      progress: 0,
      done: false,
    }))
    setItems((prev) => [...prev, ...arr])
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDrag(false)
    handleFiles(e.dataTransfer.files)
  }

  const removeItem = (id) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
  }

  const onSubmit = async () => {
    if (!items.length) {
      toast('กรุณาเลือกไฟล์ก่อน', 'err')
      return
    }
    if (!projId) {
      toast('กรุณาเลือกโครงการ', 'err')
      return
    }
    setSubmitting(true)
    let ok = 0
    let fail = 0
    for (const it of items) {
      try {
        // An empty file cannot be uploaded (the server refuses size 0): say so plainly, before any extraction/upload.
        // Per-file and non-stop - the next files are unaffected.
        if (it.file.size === 0) {
          const e = new Error('ไฟล์ว่าง (0 ไบต์) อัปโหลดไม่ได้')
          e.code = 'empty_file'
          throw e
        }
        // Extract text content for searching (PDF/DOCX/XLSX/TXT)
        let contentText = null
        try {
          setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: 30 } : x)))
          contentText = await extractText(it.file, it.name)
          if (contentText) {
            console.log(`Extracted ${contentText.length} chars from ${it.name}`)
          }
        } catch (e) {
          console.warn('Text extraction failed:', e)
        }
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: 70 } : x)))

        let lastPct = -1
        const onProgress = (pct) => {
          const p = UPLOAD_FROM + Math.round((Math.max(0, Math.min(100, pct)) * UPLOAD_SPAN) / 100)
          if (p === lastPct) return
          lastPct = p
          setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: p } : x)))
        }
        const saved = await uploadFile(projId, it.file, it.type, null, contentText, onProgress)
        // saved, but the "latest version" bookkeeping could not be completed: warn, do not fail the upload
        if (saved?._warning) toast(`${it.name}: ${saved._warning}`, 'err')
        try {
          await logActivity(projId, 'upload', `อัปโหลด ${it.name}`)
        } catch (_) {}
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: 100, done: true } : x)))
        ok++
      } catch (err) {
        fail++
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: 0 } : x)))
        // 'unsure_outcome' is not a known failure: the message itself tells the person what to check
        toast(err?.code === 'unsure_outcome' ? `${it.name}: ${err.message}` : `อัปโหลด ${it.name} ไม่สำเร็จ: ${err.message}`, 'err')
        // the next files would hit the same wall: stop and tell the person once
        if (STOP_CODES.has(err?.code)) {
          if (items.length > fail + ok) toast('หยุดการอัปโหลดไฟล์ที่เหลือ — แก้ไขปัญหาข้างต้นแล้วลองใหม่', 'err')
          break
        }
      }
    }
    setSubmitting(false)
    if (ok > 0) {
      toast(`อัปโหลด ${ok} ไฟล์สำเร็จ${fail > 0 ? ` (ล้มเหลว ${fail})` : ''}`)
      onUploaded?.()
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => { if (!submitting) onClose() }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>อัปโหลดเอกสารใหม่</h3>
          <button className="icon-btn" onClick={onClose} disabled={submitting} aria-label="ปิด">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>โครงการ</label>
              {projects.length === 0 ? (
                <div className="muted small" style={{ padding: '10px 12px', background: 'var(--gray-100)', borderRadius: 8 }}>
                  ไม่มีโครงการที่คุณมีสิทธิ์อัปโหลด
                </div>
              ) : (
                <select value={projId} onChange={(e) => setProjId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.code})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>ประเภทเอกสาร</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="auto">🤖 จัดประเภทอัตโนมัติ</option>
                {TYPE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {TYPE_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ height: 14 }} />

          <label
            className={`dropzone ${drag ? 'drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)}
            />
            <div className="ic">
              <Icon name="upload" size={32} />
            </div>
            <div className="t">ลากไฟล์มาวางที่นี่ หรือคลิกเลือก</div>
            <div className="s">รองรับ PDF, Word, Excel, JPG, PNG, ZIP</div>
            <div className="s" style={{ marginTop: 2 }}>ไฟล์ ZIP เก็บไว้เป็นไฟล์และค้นหาจากชื่อได้ (ระบบยังไม่อ่านเนื้อหาข้างใน)</div>
          </label>

          {items.length > 0 && (
            <div className="upload-list">
              {items.map((it) => (
                <div className="upload-item" key={it.id}>
                  <div
                    className="file-ico"
                    style={{ width: 24, height: 24, fontSize: 9, background: TYPE_COLOR[it.type], color: 'white' }}
                  >
                    {(TYPE_LABEL[it.type] || it.type).slice(0, 3)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontWeight: 500,
                        color: 'var(--navy)',
                        fontSize: 13,
                      }}
                    >
                      {it.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>
                      {TYPE_LABEL[it.type] || it.type} {it.version ? `· ${it.version}` : ''} · {fmtSize(it.size)}
                    </div>
                  </div>
                  <div className="bar" style={{ width: 80 }}>
                    <div className="fill" style={{ width: `${it.progress}%` }} />
                  </div>
                  {it.done ? (
                    <Icon name="check" size={14} style={{ color: 'var(--green)' }} />
                  ) : (
                    <button className="icon-btn" onClick={() => removeItem(it.id)} disabled={submitting}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {submitting && <span className="muted small" style={{ marginRight: 'auto' }}>กำลังอัปโหลด อย่าปิดหน้านี้</span>}
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={submitting || items.length === 0 || !projId}>
            <Icon name="check" size={14} />
            {submitting ? 'กำลังอัปโหลด...' : `ยืนยันอัปโหลด (${items.length})`}
          </button>
        </div>
      </div>
    </div>
  )
}
