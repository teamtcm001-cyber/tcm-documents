import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import PreviewModal from './PreviewModal.jsx'
import {
  fetchChecklist, addChecklistItem, updateChecklistItem, removeChecklistItem,
  attachFileToChecklistItem, detachFileFromChecklistItem, fetchLatestVersionOfFile,
  fetchFiles, fetchChecklistTemplate, addChecklistTemplateItem, removeChecklistTemplateItem, applyChecklistTemplate,
} from '../api/supabase.js'
import { normalizeFile, fmtSize, TYPE_LABEL, TYPE_COLOR, detectVersion } from '../utils/format.js'
import { fmtThaiDate } from '../utils/tracking.js'
import { ToneBadge, NotInstalledNotice } from './TrackingBits.jsx'

// ---------- file picker: existing files of THIS project (no upload flow here) ----------
function FilePickerModal({ projectId, itemLabel, currentFileId, onPick, onClose, onOpenUpload }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [latestOnly, setLatestOnly] = useState(true)

  useEffect(() => {
    let alive = true
    fetchFiles(projectId)
      .then((rows) => alive && setFiles(rows.map(normalizeFile)))
      .catch((e) => alive && setError(e.message || 'โหลดไฟล์ไม่สำเร็จ'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const types = ['all', ...Array.from(new Set(files.map((f) => f.type)))]
  const q = search.trim().toLowerCase()
  const shown = files
    .filter((f) => !latestOnly || f.isLatest)
    .filter((f) => type === 'all' || f.type === type)
    .filter((f) => !q || f.name.toLowerCase().includes(q))

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 120 }}>
      <div
        className="modal trk-modal"
        role="dialog"
        aria-modal="true"
        aria-label="แนบไฟล์จากโครงการนี้"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3>แนบไฟล์จากโครงการนี้</h3>
            <div className="muted small">สำหรับรายการ: {itemLabel}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="ปิด">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="drawer-search" style={{ marginBottom: 10 }}>
            <Icon name="search" size={15} style={{ color: 'var(--gray-500)' }} />
            <input
              autoFocus
              placeholder="ค้นหาชื่อไฟล์..."
              aria-label="ค้นหาชื่อไฟล์"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {types.map((t) => (
              <button
                key={t}
                type="button"
                className={`filter-chip ${type === t ? 'on' : ''}`}
                aria-pressed={type === t}
                onClick={() => setType(t)}
              >
                {t === 'all' ? 'ทั้งหมด' : TYPE_LABEL[t] || t}
              </button>
            ))}
            <button
              type="button"
              className={`filter-chip ${latestOnly ? 'on' : ''}`}
              aria-pressed={latestOnly}
              onClick={() => setLatestOnly((v) => !v)}
              style={{ marginLeft: 'auto' }}
            >
              <Icon name="bolt" size={11} /> เฉพาะเวอร์ชันล่าสุด
            </button>
          </div>

          {loading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 32 }}>
              <div className="spinner" />
            </div>
          ) : error ? (
            <div className="auth-msg err">{error}</div>
          ) : shown.length === 0 ? (
            <div className="trk-empty">
              {files.length === 0 ? 'โครงการนี้ยังไม่มีเอกสารในระบบ' : 'ไม่พบไฟล์ที่ตรงกับเงื่อนไข'}
            </div>
          ) : (
            <ul className="trk-pick-list">
              {shown.map((f) => {
                const ver = detectVersion(f.name)
                return (
                  <li key={f.id} className="trk-pick-row">
                    <div className="file-ico" style={{ background: TYPE_COLOR[f.type] || '#6B7280' }}>
                      {(TYPE_LABEL[f.type] || f.type).slice(0, 3)}
                    </div>
                    <div className="file-meta" style={{ flex: 1 }}>
                      <div className="fn" title={f.name}>{f.name}</div>
                      <div className="info">
                        <span>{(f.ext || '').toUpperCase()} · {fmtSize(f.size)}</span>
                        {ver && <span>{ver}</span>}
                        <span>อัปโหลด {fmtThaiDate(f.date)}</span>
                        {!f.isLatest && <ToneBadge tone="mute">เวอร์ชันเก่า</ToneBadge>}
                      </div>
                    </div>
                    {f.id === currentFileId ? (
                      <ToneBadge tone="ok">แนบอยู่</ToneBadge>
                    ) : (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => onPick(f)}>
                        <Icon name="paperclip" size={13} /> แนบ
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          {onOpenUpload ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                onClose()
                onOpenUpload()
              }}
            >
              <Icon name="upload" size={13} /> ยังไม่มีไฟล์? อัปโหลดเอกสาร
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- per-project template (copied into NEW installments) ----------
function TemplateModal({ projectId, onClose }) {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [notInstalled, setNotInstalled] = useState(false)
  const [label, setLabel] = useState('')
  const [required, setRequired] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const res = await fetchChecklistTemplate(projectId)
    setNotInstalled(res.notInstalled)
    if (res.error && !res.notInstalled) toast('โหลดแม่แบบไม่สำเร็จ: ' + res.error.message, 'err')
    setItems(res.data || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [projectId])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const add = async (e) => {
    e.preventDefault()
    if (!label.trim()) return
    setBusy(true)
    try {
      await addChecklistTemplateItem(projectId, { label, required })
      setLabel('')
      await load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (it) => {
    setBusy(true)
    try {
      await removeChecklistTemplateItem(it.id)
      await load()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 120 }}>
      <div className="modal trk-modal" role="dialog" aria-modal="true" aria-label="แม่แบบเช็กลิสต์เอกสาร" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>แม่แบบเช็กลิสต์เอกสารของโครงการ</h3>
            <div className="muted small">รายการเหล่านี้จะถูกคัดลอกใส่ "งวดที่สร้างใหม่" อัตโนมัติ (งวดเดิมไม่เปลี่ยน)</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="ปิด">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {notInstalled ? (
            <NotInstalledNotice />
          ) : loading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
              <div className="spinner" />
            </div>
          ) : (
            <>
              {items.length === 0 ? (
                <div className="trk-empty">ยังไม่มีรายการในแม่แบบ</div>
              ) : (
                <ul className="trk-tpl-list">
                  {items.map((it) => (
                    <li key={it.id}>
                      <span>
                        {it.label} {!it.required && <ToneBadge tone="mute">ไม่บังคับ</ToneBadge>}
                      </span>
                      <button
                        type="button"
                        className="icon-btn danger"
                        aria-label={`ลบ ${it.label} ออกจากแม่แบบ`}
                        disabled={busy}
                        onClick={() => remove(it)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="trk-add-row" onSubmit={add} style={{ marginTop: 14 }}>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="ชื่อเอกสาร เช่น ใบส่งมอบงาน"
                  aria-label="ชื่อเอกสารในแม่แบบ"
                />
                <label className="trk-check">
                  <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> จำเป็น
                </label>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !label.trim()}>
                  <Icon name="plus" size={13} /> เพิ่ม
                </button>
              </form>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- checklist for one installment ----------
export default function TrackingChecklist({ installment, projectId, onChanged, onOpenUpload }) {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [notInstalled, setNotInstalled] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [picker, setPicker] = useState(null) // checklist item
  const [preview, setPreview] = useState(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [required, setRequired] = useState(true)

  const load = async () => {
    const res = await fetchChecklist(installment.installment_id)
    setNotInstalled(res.notInstalled)
    setLoadError(res.error && !res.notInstalled ? res.error.message : '')
    setItems(res.data || [])
    setLoading(false)
  }
  useEffect(() => {
    setLoading(true)
    load()
  }, [installment.installment_id])

  // run a write, then refresh both this list and the parent summary counts
  const act = async (id, fn, okMsg) => {
    setBusyId(id)
    try {
      await fn()
      if (okMsg) toast(okMsg)
      await load()
      await onChanged?.()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusyId(null)
    }
  }

  const requiredItems = items.filter((i) => i.required)
  const attachedRequired = requiredItems.filter((i) => i.file_id).length
  const allReady = requiredItems.length > 0 && attachedRequired === requiredItems.length

  const switchToLatest = (it) =>
    act(it.id, async () => {
      const res = await fetchLatestVersionOfFile(it.file)
      if (res.error) throw new Error('ค้นหาเวอร์ชันล่าสุดไม่สำเร็จ: ' + res.error.message)
      if (!res.data) throw new Error('ไม่พบเวอร์ชันล่าสุดของไฟล์นี้')
      if (res.data.id === it.file_id) throw new Error('ไฟล์ที่แนบเป็นเวอร์ชันล่าสุดอยู่แล้ว')
      await attachFileToChecklistItem(it.id, res.data.id)
    }, 'เปลี่ยนเป็นเวอร์ชันล่าสุดแล้ว')

  const addItem = async (e) => {
    e.preventDefault()
    if (!label.trim()) return
    setBusyId('add')
    try {
      await addChecklistItem(installment.installment_id, projectId, { label, required })
      setLabel('')
      await load()
      await onChanged?.()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusyId(null)
    }
  }

  if (notInstalled) return <NotInstalledNotice />

  return (
    <div className="trk-checklist">
      <div className="trk-cl-head">
        <div className="trk-sub-h" style={{ margin: 0 }}>
          <Icon name="checklist" size={15} /> เช็กลิสต์เอกสาร
        </div>
        {!loading && requiredItems.length > 0 ? (
          <ToneBadge tone={allReady ? 'ok' : 'warn'}>
            พร้อม {attachedRequired}/{requiredItems.length}
          </ToneBadge>
        ) : (
          !loading && <ToneBadge tone="mute">ยังไม่ตั้งเช็กลิสต์</ToneBadge>
        )}
        <button type="button" className="trk-link-btn" style={{ marginLeft: 'auto' }} onClick={() => setTemplateOpen(true)}>
          แม่แบบของโครงการ
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 20 }}>
          <div className="spinner" style={{ width: 24, height: 24 }} />
        </div>
      ) : loadError ? (
        <div className="auth-msg err">โหลดเช็กลิสต์ไม่สำเร็จ: {loadError}</div>
      ) : (
        <>
          {items.length === 0 ? (
            <div className="trk-empty">
              ยังไม่มีรายการเอกสารในงวดนี้
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busyId === 'tpl'}
                  onClick={() =>
                    act(
                      'tpl',
                      async () => {
                        const n = await applyChecklistTemplate(installment.installment_id, projectId)
                        if (n === 0) throw new Error('แม่แบบของโครงการยังว่างอยู่ — เพิ่มรายการที่ "แม่แบบของโครงการ" ก่อน')
                      },
                      'นำแม่แบบมาใส่แล้ว'
                    )
                  }
                >
                  ใช้แม่แบบของโครงการ
                </button>
              </div>
            </div>
          ) : (
            <ul className="trk-docs">
              {items.map((it) => {
                const f = it.file
                const outdated = f && f.is_latest === false
                const ver = f ? detectVersion(f.name) : null
                const busy = busyId === it.id
                const state = f ? (outdated ? 'warn' : 'ok') : it.required ? 'missing' : 'optional'
                return (
                  <li key={it.id} className={`trk-doc trk-doc-${state}`}>
                    <div className="trk-doc-mark" aria-hidden="true">
                      <Icon name={f ? 'circle-check' : it.required ? 'alert' : 'info'} size={18} />
                    </div>
                    <div className="trk-doc-main">
                      <div className="trk-doc-label">
                        {it.label}
                        {!it.required && <ToneBadge tone="mute">ไม่บังคับ</ToneBadge>}
                      </div>
                      {f ? (
                        <div className="trk-doc-file">
                          <button type="button" className="trk-file-link" onClick={() => setPreview(normalizeFile(f))} title="ดูตัวอย่างไฟล์">
                            <Icon name="file" size={13} /> {f.name}
                          </button>
                          <span className="muted small">
                            {(f.ext || '').toUpperCase()}
                            {ver ? ` · ${ver}` : ''} · อัปโหลด {fmtThaiDate((f.created_at || '').slice(0, 10))}
                            {it.attached_by ? ` · แนบโดย ${it.attached_by}` : ''}
                          </span>
                          {outdated && <ToneBadge tone="warn">มีเวอร์ชันใหม่กว่า</ToneBadge>}
                        </div>
                      ) : (
                        <div className={`trk-doc-none ${it.required ? 'req' : ''}`}>ยังไม่มีในระบบ</div>
                      )}
                    </div>
                    <div className="trk-doc-actions">
                      <label className="trk-check" title="เอกสารจำเป็นต้องมีก่อนเบิก">
                        <input
                          type="checkbox"
                          checked={it.required}
                          disabled={busy}
                          onChange={(e) =>
                            act(it.id, () => updateChecklistItem(it.id, { required: e.target.checked }))
                          }
                        />
                        จำเป็น
                      </label>
                      {outdated && (
                        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => switchToLatest(it)}>
                          ใช้เวอร์ชันล่าสุด
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setPicker(it)}>
                        <Icon name="paperclip" size={13} /> {f ? 'เปลี่ยนไฟล์' : 'แนบไฟล์จากโครงการนี้'}
                      </button>
                      {f && (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`ถอดไฟล์ออกจาก ${it.label}`}
                          title="ถอดไฟล์ (ไม่ลบไฟล์ในระบบ)"
                          disabled={busy}
                          onClick={() => act(it.id, () => detachFileFromChecklistItem(it.id), 'ถอดไฟล์แล้ว')}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn danger"
                        aria-label={`ลบรายการ ${it.label}`}
                        title="ลบรายการนี้ออกจากเช็กลิสต์"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`ลบรายการ "${it.label}" ออกจากเช็กลิสต์งวดนี้?`))
                            act(it.id, () => removeChecklistItem(it.id), 'ลบรายการแล้ว')
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <form className="trk-add-row" onSubmit={addItem}>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="เพิ่มรายการเอกสารเอง เช่น หนังสือรับรองผลงาน"
              aria-label="ชื่อเอกสารที่ต้องการเพิ่ม"
            />
            <label className="trk-check">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> จำเป็น
            </label>
            <button type="submit" className="btn btn-ghost btn-sm" disabled={busyId === 'add' || !label.trim()}>
              <Icon name="plus" size={13} /> เพิ่มรายการ
            </button>
          </form>
        </>
      )}

      {picker && (
        <FilePickerModal
          projectId={projectId}
          itemLabel={picker.label}
          currentFileId={picker.file_id}
          onClose={() => setPicker(null)}
          onOpenUpload={onOpenUpload}
          onPick={(file) => {
            const it = picker
            setPicker(null)
            act(it.id, () => attachFileToChecklistItem(it.id, file.id), `แนบ "${file.name}" แล้ว`)
          }}
        />
      )}
      {templateOpen && <TemplateModal projectId={projectId} onClose={() => setTemplateOpen(false)} />}
      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
