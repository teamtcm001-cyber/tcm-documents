import { useState, useEffect, useRef } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { fetchProjects, uploadFile, logActivity } from '../api/supabase.js'
import { fmtSize, detectType, detectVersion, TYPE_LABEL, TYPE_COLOR, TYPE_KEYS } from '../utils/format.js'
import { extractText } from '../utils/textExtract.js'

export default function UploadModal({ user, onClose, onUploaded }) {
  const [projects, setProjects] = useState([])
  const [projId, setProjId] = useState('')
  const [type, setType] = useState('auto')
  const [items, setItems] = useState([])
  const [drag, setDrag] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    fetchProjects().then((data) => {
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
    // simulate progress animation before real upload
    arr.forEach((it) => {
      let p = 0
      const tk = setInterval(() => {
        p += Math.random() * 25 + 15
        if (p >= 95) {
          p = 95
          clearInterval(tk)
        }
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: p } : x)))
      }, 220)
    })
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

        await uploadFile(projId, it.file, it.type, null, contentText)
        try {
          await logActivity(projId, 'upload', `อัปโหลด ${it.name}`, null, { anonymous: true })
        } catch (_) {}
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, progress: 100, done: true } : x)))
        ok++
      } catch (err) {
        fail++
        toast(`อัปโหลด ${it.name} ไม่สำเร็จ: ${err.message}`, 'err')
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>อัปโหลดเอกสารใหม่</h3>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>โครงการ</label>
              {projects.length === 0 ? (
                <div className="muted small" style={{ padding: '10px 12px', background: 'var(--gray-100)', borderRadius: 8 }}>
                  ยังไม่มีโครงการ
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
            <div className="s">รองรับ PDF, Word, Excel, JPG, PNG</div>
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
