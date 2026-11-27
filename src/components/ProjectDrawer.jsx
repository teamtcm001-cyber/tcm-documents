import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import {
  fetchFiles, deleteFile, downloadFile, deleteProject, getFileBlob, updateFileContent, updateProjectStatus,
} from '../api/supabase.js'
import { statusOptions, statusLabel, CLOSED_PROJECT_STATUS, CLOSE_PROJECT_CONFIRM } from '../utils/tracking.js'
import { fmtSize, fmtDate, normalizeFile, computeIsLatest, TYPE_LABEL, TYPE_COLOR, TYPE_BG, TYPE_TEXT } from '../utils/format.js'
import { extractTextFromBlobDetailed, RESULT, EXTRACTABLE_RE } from '../utils/textExtract.js'
import PreviewModal from './PreviewModal.jsx'
import Dialog from './ui/Dialog.jsx'
import { ReadOnlyBadge, ManagerBadge } from './AccessBits.jsx'
import ProjectMembersPanel from './ProjectMembersPanel.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { CoContact } from './TrackingBits.jsx'
import { useZipDownload } from './ZipDownload.jsx'
import { fmtBytes, planZip } from '../utils/zipDownload.js'

// version groups (type + base name, newest first), the groups that pass the search / type filter, and the rows on screen
// (every version, or only the newest of each group with "ล่าสุด")
function layoutFiles(files, filter, search, latestOnly) {
  const groups = {}
  files.forEach((f) => {
    const k = `${f.type}|${f.baseName}`
    if (!groups[k]) groups[k] = []
    groups[k].push(f)
  })
  Object.values(groups).forEach((g) => g.sort((a, b) => new Date(b.date) - new Date(a.date)))
  const filteredKeys = Object.keys(groups).filter((k) => {
    const [type, baseName] = k.split('|')
    if (filter !== 'all' && type !== filter) return false
    if (search && !baseName.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const displayedFiles = filteredKeys.flatMap((k) => (latestOnly ? groups[k].slice(0, 1) : groups[k]))
  return { groups, filteredKeys, displayedFiles }
}

function FileRow({ file, canEdit, selected, onToggle, onDelete, onDownload, onPreview }) {
  const color = TYPE_COLOR[file.type] || '#6B7280'
  const label = TYPE_LABEL[file.type] || file.type
  return (
    <div className={`file-row selectable ${selected ? 'selected' : ''}`}>
      <input
        type="checkbox"
        className="file-check"
        checked={selected}
        onChange={() => onToggle(file.id)}
        aria-label={`เลือกไฟล์ ${file.name}`}
        data-testid="file-check"
      />
      <div className="file-ico" style={{ background: color, cursor: 'pointer' }} onClick={() => onPreview(file)}>
        {label.length > 3 ? label.slice(0, 3) : label}
      </div>
      <div className="file-meta" style={{ cursor: 'pointer' }} onClick={() => onPreview(file)}>
        <div className="fn">{file.name}</div>
        <div className="info">
          <span>{(file.ext || '').toUpperCase()} · {fmtSize(file.size)}</span>
          <span>{fmtDate(file.date)}</span>
          {file.uploader && <span>โดย {file.uploader}</span>}
        </div>
      </div>
      <div>
        {file.isLatest ? (
          <span className="badge badge-latest">ล่าสุด</span>
        ) : (
          <span className="badge badge-old">เก่า</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="icon-btn" title="ดูตัวอย่าง" onClick={() => onPreview(file)}>
          <Icon name="eye" size={15} />
        </button>
        <button className="icon-btn" title="ดาวน์โหลด" onClick={() => onDownload(file)}>
          <Icon name="download" size={15} />
        </button>
        {canEdit && (
          <button
            className="icon-btn danger"
            title="ลบ"
            aria-label={`ลบไฟล์ ${file.name}`}
            onClick={() => {
              const msg = `ลบไฟล์ "${file.name}" ?\n\nไฟล์จะถูกลบถาวร และจะถูกถอดออกจากเช็กลิสต์งวดเบิกที่แนบไว้`
              if (window.confirm(msg)) onDelete(file)
            }}
          >
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

export default function ProjectDrawer({ project, refreshKey, onClose, onChanged, onOpenTracking, onStatusChanged }) {
  const { canEditProject, canDeleteProject, canManageProject, isAdmin } = useAuth()
  const canEdit = canEditProject(project?.id)
  // "สมาชิกโครงการ" tab: the project's managers and admins only (the RPCs enforce it as well)
  const canManage = canManageProject(project?.id)
  const [tab, setTab] = useState('docs') // 'docs' | 'members'
  const tabsId = useId()
  const tabRefs = { docs: useRef(null), members: useRef(null) }
  const activeTab = canManage ? tab : 'docs' // the tab disappears (back to documents) if the manager role is lost
  const [statusSaving, setStatusSaving] = useState(false)
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showLatestOnly, setShowLatestOnly] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexProgress, setReindexProgress] = useState({ current: 0, total: 0 })
  const [reindexReport, setReindexReport] = useState(null) // { ok, failed: [{name, reason}], empty: [{name, reason}] }
  const [previewFile, setPreviewFile] = useState(null)
  const [selected, setSelected] = useState(() => new Set()) // ids of the ticked documents (displayed versions)
  const toast = useToast()
  const zip = useZipDownload()

  useEffect(() => {
    if (!project) return
    load()
  }, [project, refreshKey])

  useEffect(() => setTab('docs'), [project?.id])
  useEffect(() => setSelected(new Set()), [project?.id])

  // arrow keys move between the two tabs (WAI-ARIA tabs pattern)
  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const next = e.key === 'ArrowLeft' || e.key === 'Home' ? 'docs' : 'members'
    setTab(next)
    tabRefs[next].current?.focus()
  }

  const load = async () => {
    setLoading(true)
    try {
      const rows = await fetchFiles(project.id)
      const normalized = rows.map(normalizeFile)
      computeIsLatest(normalized)
      setFiles(normalized)
      // a ticked file that is gone (deleted here or elsewhere) can no longer be selected
      setSelected((prev) => {
        const ids = new Set(normalized.map((f) => f.id))
        const next = new Set([...prev].filter((id) => ids.has(id)))
        return next.size === prev.size ? prev : next
      })
    } catch (err) {
      toast('โหลดไฟล์ไม่สำเร็จ: ' + err.message, 'err')
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async (file) => {
    try {
      await downloadFile(file.id, file.name)
      toast(`ดาวน์โหลด ${file.name}`)
    } catch (err) {
      toast(err?.message || 'ดาวน์โหลดไม่สำเร็จ', 'err')
    }
  }

  const toggleSelected = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleDelete = async (file) => {
    try {
      await deleteFile(file.id)
      setSelected((prev) => {
        if (!prev.has(file.id)) return prev
        const next = new Set(prev)
        next.delete(file.id)
        return next
      })
      toast('ลบไฟล์เรียบร้อย')
      await load()
      onChanged?.()
    } catch (err) {
      toast(err?.message || 'ลบไม่สำเร็จ', 'err')
    }
  }

  const handleStatusChange = async (e) => {
    const next = e.target.value
    const prev = project.status || ''
    if (next === prev) return
    if (next === CLOSED_PROJECT_STATUS && !window.confirm(CLOSE_PROJECT_CONFIRM)) return
    setStatusSaving(true)
    try {
      const row = await updateProjectStatus(project.id, next, { previousStatus: prev })
      toast(`เปลี่ยนสถานะโครงการเป็น "${statusLabel(next)}" เรียบร้อย`)
      onStatusChanged?.(row)
    } catch (err) {
      toast(err.message || 'เปลี่ยนสถานะโครงการไม่สำเร็จ', 'err')
    } finally {
      setStatusSaving(false)
    }
  }

  const handleDeleteProject = async () => {
    if (
      !window.confirm(
        `ลบโครงการ "${project.name}" และไฟล์ทั้งหมด?\n\n` +
          'ข้อมูลเบิกงวดงานทั้งหมดของโครงการนี้จะถูกลบถาวรด้วย ได้แก่ ประวัติ % ความคืบหน้า, งวดเบิก, ' +
          'ประวัติสถานะงวด และเช็กลิสต์เอกสาร — กู้คืนไม่ได้'
      )
    )
      return
    try {
      await deleteProject(project.id)
      toast('ลบโครงการเรียบร้อย')
      onChanged?.()
      onClose()
    } catch (err) {
      toast(err?.message || 'ลบโครงการไม่สำเร็จ', 'err')
    }
  }

  const handleReindex = async () => {
    // ocrNoText = OCR already ran and found no text (a site photo): do not OCR it again
    const needIndex = files.filter((f) => !f.contentText && !f.ocrNoText && EXTRACTABLE_RE.test(f.name))
    if (needIndex.length === 0) {
      toast('ทุกไฟล์ index แล้ว ✅')
      return
    }
    if (!window.confirm(`Re-index เนื้อหา ${needIndex.length} ไฟล์? (อาจใช้เวลาสักครู่ — PDF สแกนและรูปภาพจะอ่านด้วย OCR หน้าละไม่กี่วินาที อย่าปิดหน้านี้ระหว่างทำ)`)) return

    setReindexing(true)
    setReindexReport(null)
    setReindexProgress({ current: 0, total: needIndex.length })
    const okList = []
    const failList = []
    const emptyList = []

    for (let i = 0; i < needIndex.length; i++) {
      const f = needIndex[i]
      setReindexProgress({ current: i + 1, total: needIndex.length })
      try {
        const blob = await getFileBlob(f.id)
        const result = await extractTextFromBlobDetailed(blob, f.name, {
          ocr: true,
          onOcrProgress: ({ page, pages }) => setReindexProgress({ current: i + 1, total: needIndex.length, ocrPage: page, ocrPages: pages }),
        })

        if (result.status === RESULT.SUCCESS) {
          const updated = await updateFileContent(f.id, result.text)
          if (updated) {
            okList.push({ name: f.name })
          } else {
            failList.push({ name: f.name, reason: 'บันทึกลง DB ไม่ได้ (ตรวจสอบว่า run migration แล้ว)' })
          }
        } else if (result.status === RESULT.EMPTY) {
          // OCR found no text: remember that (short marker), so the next re-index skips this file
          if (result.storeText) {
            try {
              await updateFileContent(f.id, result.storeText)
            } catch (_) {
              /* only a skip-marker; the file just gets OCR'd again next time */
            }
          }
          emptyList.push({ name: f.name, reason: result.error || 'ไม่มีข้อความให้สกัด' })
        } else {
          failList.push({ name: f.name, reason: result.error || 'ไม่ทราบสาเหตุ' })
        }
      } catch (err) {
        console.error('Reindex error:', f.name, err)
        failList.push({ name: f.name, reason: err?.message || 'ดาวน์โหลดไฟล์ไม่สำเร็จ' })
        // no permission / session over: the remaining files would fail the same way
        if (['no_access', 'unauthorized', 'auth_unavailable', 'rate_limited'].includes(err?.code)) {
          const rest = needIndex.length - i - 1
          if (rest > 0) failList.push({ name: `อีก ${rest} ไฟล์`, reason: 'ข้ามไป เพราะขั้นตอนก่อนหน้าไม่สำเร็จ' })
          break
        }
      }
    }

    setReindexing(false)
    setReindexProgress({ current: 0, total: 0 })
    setReindexReport({ ok: okList, failed: failList, empty: emptyList })

    const total = okList.length + failList.length + emptyList.length
    toast(
      `Re-index เสร็จสิ้น: ${okList.length}/${total} สำเร็จ${
        emptyList.length ? ` · ${emptyList.length} ไม่มีข้อความ` : ''
      }${failList.length ? ` · ${failList.length} ผิดพลาด` : ''}`
    )
    await load()
  }

  const { groups, filteredKeys, displayedFiles } = useMemo(
    () => layoutFiles(files, filter, search, showLatestOnly),
    [files, filter, search, showLatestOnly]
  )
  // the selection only ever holds rows that are on screen: a search / filter / "ล่าสุด" change drops the ticks that
  // just disappeared (so "เลือก N ไฟล์" and the zip always match what the person sees)
  const displayedKey = displayedFiles.map((f) => f.id).join('|')
  useEffect(() => {
    const ids = new Set(displayedFiles.map((f) => f.id))
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedKey])

  if (!project) return null

  const typesInProject = Array.from(new Set(files.map((f) => f.type)))
  const types = ['all', ...typesInProject]

  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0)

  const selectedFiles = files.filter((f) => selected.has(f.id))
  const selectedPlan = planZip(selectedFiles)
  const allDisplayedSelected = displayedFiles.length > 0 && displayedFiles.every((f) => selected.has(f.id))
  const someDisplayedSelected = displayedFiles.some((f) => selected.has(f.id))

  const selectAllDisplayed = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      displayedFiles.forEach((f) => next.add(f.id))
      return next
    })
  const downloadSelectedZip = () => zip.begin({ files: selectedFiles, projectCode: project.code, scope: 'ไฟล์ที่เลือก', confirm: false })
  // re-reads the project's FULL list (paged, no content_text): the drawer's own list may be capped / stale
  const downloadProjectZip = () => zip.beginProject(project)

  return (
    <>
      <div className="drawer-bd" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="top">
            <div
              style={{
                padding: '4px 10px',
                background: 'rgba(255,255,255,0.18)',
                borderRadius: 999,
                fontSize: 11,
                fontFamily: 'Prompt',
                fontWeight: 500,
                letterSpacing: '0.04em',
              }}
            >
              {project.code} ·{' '}
              {onStatusChanged && canEdit ? (
                <select
                  className="drawer-status-select"
                  aria-label="สถานะโครงการ"
                  value={project.status || ''}
                  onChange={handleStatusChange}
                  disabled={statusSaving}
                  title="เปลี่ยนสถานะโครงการ"
                >
                  {statusOptions(project.status).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                statusLabel(project.status) || 'active'
              )}
            </div>
            <button className="close" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          </div>
          <h2>{project.name}</h2>
          <div className="info">
            {project.client && (
              <span>
                <Icon name="building" size={13} /> {project.client}
              </span>
            )}
            <span>
              <Icon name="file" size={13} /> {files.length} ไฟล์
            </span>
            <span>
              <Icon name="layers" size={13} /> {fmtSize(totalSize)}
            </span>
          </div>
          {(project.project_co || project.project_co_phone) && (
            <div className="info drawer-co" data-testid="drawer-co">
              <span>
                <Icon name="user" size={13} /> Project Co:{' '}
                <CoContact co={project.project_co} phone={project.project_co_phone} empty={null} />
              </span>
              {onOpenTracking && canEdit && (
                <button
                  type="button"
                  className="drawer-co-edit"
                  onClick={() => onOpenTracking(project)}
                  title="เปิดหน้าเบิกงวดงานเพื่อแก้ไขชื่อ Project Co และเบอร์ติดต่อ"
                >
                  ตั้งค่า
                </button>
              )}
            </div>
          )}
          {!canEdit && (
            <div style={{ marginTop: 10 }}>
              <ReadOnlyBadge className="on-dark" />
            </div>
          )}
          {canManage && !isAdmin && (
            <div style={{ marginTop: 10 }}>
              <ManagerBadge className="on-dark" />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={downloadProjectZip}
              disabled={loading || files.length === 0 || zip.busy}
              title={files.length === 0 ? 'ยังไม่มีเอกสารในโครงการนี้' : 'รวมไฟล์เวอร์ชันล่าสุดของทุกเอกสารเป็น Zip'}
              data-testid="zip-project"
            >
              <Icon name="zip" size={13} /> Zip ทั้งโครงการ
            </button>
            {onOpenTracking && (
              <button
                className="btn btn-sm"
                style={{
                  background: 'rgba(255,255,255,0.15)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
                onClick={() => onOpenTracking(project)}
                title="ดู % ความคืบหน้า งวดเบิก และความพร้อมของเอกสาร"
              >
                <Icon name="trend-up" size={13} /> เบิกงวดงาน
              </button>
            )}
            {canEdit && (
              <button
                className="btn btn-sm"
                style={{
                  background: 'rgba(255,255,255,0.15)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
                onClick={handleReindex}
                disabled={reindexing}
                title="สกัดข้อความจากเอกสารเก่า เพื่อให้ AI ค้นในเนื้อหาได้"
              >
                <Icon name="sparkles" size={13} />
                {reindexing
                  ? `กำลัง index... ${reindexProgress.current}/${reindexProgress.total}${reindexProgress.ocrPages ? ` (OCR หน้า ${reindexProgress.ocrPage}/${reindexProgress.ocrPages})` : ''}`
                  : 'Re-index เนื้อหา'}
              </button>
            )}
            {canDeleteProject && (
              <button
                className="btn btn-sm"
                style={{
                  background: 'rgba(229,72,77,0.2)',
                  color: 'white',
                  border: '1px solid rgba(229,72,77,0.4)',
                  marginLeft: 'auto',
                }}
                onClick={handleDeleteProject}
              >
                <Icon name="trash" size={13} /> ลบโครงการ
              </button>
            )}
          </div>
        </div>

        {canManage && (
          <div className="drawer-tabs" role="tablist" aria-label="ส่วนของโครงการ" onKeyDown={onTabKey}>
            <button
              type="button"
              role="tab"
              id={`${tabsId}-docs`}
              aria-selected={activeTab === 'docs'}
              aria-controls={`${tabsId}-panel`}
              tabIndex={activeTab === 'docs' ? 0 : -1}
              ref={tabRefs.docs}
              className="drawer-tab"
              onClick={() => setTab('docs')}
            >
              <Icon name="file" size={14} /> เอกสาร
            </button>
            <button
              type="button"
              role="tab"
              id={`${tabsId}-members`}
              aria-selected={activeTab === 'members'}
              aria-controls={`${tabsId}-panel`}
              tabIndex={activeTab === 'members' ? 0 : -1}
              ref={tabRefs.members}
              className="drawer-tab"
              onClick={() => setTab('members')}
              data-testid="tab-members"
            >
              <Icon name="users" size={14} /> สมาชิกโครงการ
            </button>
          </div>
        )}

        {activeTab === 'members' ? (
          <div className="drawer-body" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-members`}>
            <ProjectMembersPanel project={project} />
          </div>
        ) : (
          <>
            <div className="drawer-tools">
              <div className="drawer-search">
                <Icon name="search" size={15} style={{ color: 'var(--gray-500)' }} />
                <input
                  placeholder="ค้นหาในเอกสาร..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button
                className={`filter-chip ${showLatestOnly ? 'on' : ''}`}
                onClick={() => setShowLatestOnly((s) => !s)}
                title="แสดง Version ล่าสุดเท่านั้น"
              >
                <Icon name="bolt" size={11} /> ล่าสุด
              </button>
            </div>

            <div className="drawer-tools" style={{ borderTop: 0, paddingTop: 0, flexWrap: 'wrap' }}>
              {types.map((t) => (
                <button key={t} className={`filter-chip ${filter === t ? 'on' : ''}`} onClick={() => setFilter(t)}>
                  {t === 'all' ? 'ทั้งหมด' : TYPE_LABEL[t] || t}
                </button>
              ))}
            </div>

            {!loading && displayedFiles.length > 0 && (
              <div className="drawer-tools drawer-selectrow" style={{ borderTop: 0, paddingTop: 0 }}>
                <label className="sel-all">
                  <input
                    type="checkbox"
                    checked={allDisplayedSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someDisplayedSelected && !allDisplayedSelected
                    }}
                    onChange={() => (allDisplayedSelected ? setSelected(new Set()) : selectAllDisplayed())}
                    data-testid="select-all"
                  />{' '}
                  เลือกทั้งหมด ({displayedFiles.length})
                </label>
                <button type="button" className="filter-chip" onClick={() => setSelected(new Set())} disabled={selected.size === 0} data-testid="clear-selection">
                  ล้างที่เลือก
                </button>
              </div>
            )}

            <div className="drawer-body" {...(canManage ? { role: 'tabpanel', id: `${tabsId}-panel`, 'aria-labelledby': `${tabsId}-docs` } : {})}>
              {loading ? (
                <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
                  <div className="spinner"></div>
                </div>
              ) : filteredKeys.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray-500)' }}>
                  <Icon name="file" size={28} />
                  <div style={{ marginTop: 8 }}>
                    {files.length === 0 ? 'ยังไม่มีเอกสารในโครงการนี้' : 'ไม่พบเอกสารที่ตรงกับเงื่อนไข'}
                  </div>
                </div>
              ) : (
                filteredKeys.map((k) => {
                  const grp = groups[k]
                  const [type, baseName] = k.split('|')
                  const shown = showLatestOnly ? grp.slice(0, 1) : grp
                  return (
                    <div className="version-group" key={k}>
                      <div className="vg-head">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            className="badge"
                            style={{ padding: '3px 10px', background: TYPE_BG[type], color: TYPE_TEXT[type] }}
                          >
                            {TYPE_LABEL[type] || type}
                          </span>
                          <span style={{ fontFamily: 'Prompt' }}>{baseName}</span>
                        </div>
                        <span style={{ color: 'var(--gray-500)', fontSize: 12 }}>
                          {grp.length} version{grp.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="vg-body">
                        {shown.map((f) => (
                          <FileRow
                            key={f.id}
                            file={f}
                            canEdit={canEdit}
                            selected={selected.has(f.id)}
                            onToggle={toggleSelected}
                            onDelete={handleDelete}
                            onDownload={handleDownload}
                            onPreview={setPreviewFile}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {selected.size > 0 && (
              <div className="sel-bar" role="region" aria-label="ไฟล์ที่เลือก" data-testid="sel-bar">
                <div className="sel-bar-txt" aria-live="polite">
                  เลือก {selectedPlan.count} ไฟล์ <span className="muted">(ขนาดรวม {fmtBytes(selectedPlan.totalBytes)})</span>
                </div>
                <button type="button" className="btn btn-sm btn-primary" onClick={downloadSelectedZip} disabled={selectedPlan.count === 0 || zip.busy} data-testid="zip-selected">
                  <Icon name="zip" size={13} /> ดาวน์โหลด Zip
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {zip.dialog}

      {reindexReport && (
        <ReindexReportModal report={reindexReport} onClose={() => setReindexReport(null)} />
      )}

      {previewFile && (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </>
  )
}

function ReindexReportModal({ report, onClose }) {
  const { ok = [], failed = [], empty = [] } = report
  return (
    <Dialog
      title="📊 Re-index Report"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose} data-autofocus>
          <Icon name="check" size={14} /> รับทราบ
        </button>
      }
    >
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
            <div style={{ flex: 1, padding: 12, background: 'var(--green-50)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>สำเร็จ</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1F8E48' }}>{ok.length}</div>
            </div>
            <div style={{ flex: 1, padding: 12, background: '#FFF7E6', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>ไม่มีข้อความ</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#C77F00' }}>{empty.length}</div>
            </div>
            <div style={{ flex: 1, padding: 12, background: '#FFF5F5', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>ผิดพลาด</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#DC2626' }}>{failed.length}</div>
            </div>
          </div>

          {empty.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)', marginBottom: 8 }}>
                ⚠️ ไฟล์ที่ไม่มีข้อความ ({empty.length})
              </div>
              <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 6 }}>
                ส่วนใหญ่เป็น PDF สแกน (ภาพ) - ระบบไม่สามารถอ่านข้อความได้
              </div>
              <div style={{ maxHeight: 150, overflowY: 'auto', background: '#FFFBEB', borderRadius: 8, padding: 8 }}>
                {empty.map((item, i) => (
                  <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                    📄 <strong>{item.name}</strong>
                    <div style={{ fontSize: 10, color: 'var(--gray-500)', marginLeft: 16 }}>
                      {item.reason}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)', marginBottom: 8 }}>
                ❌ ไฟล์ที่ผิดพลาด ({failed.length})
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', background: '#FFF5F5', borderRadius: 8, padding: 8 }}>
                {failed.map((item, i) => (
                  <div key={i} style={{ fontSize: 12, marginBottom: 6 }}>
                    📄 <strong>{item.name}</strong>
                    <div style={{ fontSize: 10, color: 'var(--red)', marginLeft: 16 }}>
                      สาเหตุ: {item.reason}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Smart recommendations based on error patterns */}
          {(empty.length > 0 || failed.length > 0) && (
            <div style={{ marginTop: 12, padding: 12, background: 'var(--steel-50)', borderRadius: 8, fontSize: 12 }}>
              <strong style={{ color: 'var(--navy)' }}>💡 วิธีแก้ไข:</strong>
              <ul style={{ margin: '8px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
                {empty.some((e) => /สแกน|ภาพ|text layer/i.test(e.reason || '')) && (
                  <li>
                    <strong>PDF สแกน (ภาพ):</strong> ใช้ OCR แปลงก่อน
                    <div style={{ fontSize: 11, marginLeft: 8, color: 'var(--gray-700)' }}>
                      → Adobe Acrobat Pro: Tools → Scan & OCR → Enhance
                      <br />
                      → ฟรี: ilovepdf.com/ocr-pdf หรือ Google Drive (Open with Google Docs)
                    </div>
                  </li>
                )}
                {failed.some((e) => /Unicode|escape sequence/i.test(e.reason || '')) && (
                  <li>
                    <strong>PDF Unicode error:</strong> PDF ใช้ font/encoding พิเศษ
                    <div style={{ fontSize: 11, marginLeft: 8, color: 'var(--gray-700)' }}>
                      → ลอง Save As ใหม่ใน Acrobat (File → Save As Other → Optimized PDF)
                      <br />
                      → หรือ Print to PDF ใหม่
                    </div>
                  </li>
                )}
                {failed.some((e) => /central directory|zip file/i.test(e.reason || '')) && (
                  <li>
                    <strong>DOCX format error:</strong> ไฟล์อาจเป็น .doc รูปแบบเก่า
                    <div style={{ fontSize: 11, marginLeft: 8, color: 'var(--gray-700)' }}>
                      → เปิดด้วย Word → File → Save As → Word Document (.docx) → Upload ใหม่
                    </div>
                  </li>
                )}
                {failed.some((e) => /\.doc รูปแบบเก่า|Word 97/i.test(e.reason || '')) && (
                  <li>
                    <strong>.doc รูปแบบเก่า:</strong> ระบบรองรับเฉพาะ .docx
                    <div style={{ fontSize: 11, marginLeft: 8, color: 'var(--gray-700)' }}>
                      → Save As เป็น .docx แล้ว Upload ใหม่
                    </div>
                  </li>
                )}
                <li>
                  <strong>ข้อมูลเพิ่มเติม:</strong> ระบบยังค้นหาด้วย <em>ชื่อไฟล์ · ประเภท · วันที่</em> ได้ปกติ
                </li>
              </ul>
            </div>
          )}
        </div>
    </Dialog>
  )
}
