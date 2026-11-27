import { useCallback, useEffect, useRef, useState } from 'react'
import Dialog from './ui/Dialog.jsx'
import Icon from './Icon.jsx'
import { fetchFileAccessLog, ACCESS_LOG_PAGE } from '../api/supabase.js'
import { fmtThaiDateTime } from '../utils/tracking.js'

// "ประวัติการเปิด/ดาวน์โหลดไฟล์" — admin only (RLS on file_access_log). Rows are written by /api/drive-url.
export const ACCESS_ACTION_LABEL = {
  view: 'เปิดดู',
  download: 'ดาวน์โหลด',
  zip: 'ดาวน์โหลด Zip',
  reindex: 'อ่านเนื้อหา (Re-index)',
}

// "2026-11-27 14:05:09" in Thailand time (seconds, unlike the on-screen format)
const csvTime = (ts) => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(d)
}
const EXPORT_MAX = 20000

const csvCell = (v) => {
  const s = String(v ?? '')
  // = + - @ (and tab / CR) at the start would be run as a formula by Excel
  const safe = /^[\t\r]|^\s*[=+\-@]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export default function AdminAccessLog({ users, projects, onClose }) {
  const [filters, setFilters] = useState({ userId: '', projectId: '', action: '', fromDate: '', toDate: '' })
  const [rows, setRows] = useState([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('') // export messages: shown above the list, never instead of it
  const seq = useRef(0) // only the latest load may set state

  const load = useCallback(
    async (append) => {
      const my = ++seq.current
      setLoading(true)
      setError('')
      try {
        const beforeId = append && rows.length ? rows[rows.length - 1].id : undefined
        const page = await fetchFileAccessLog({ ...filters, beforeId })
        if (my !== seq.current) return
        setRows((prev) => (append ? [...prev, ...page] : page))
        setMore(page.length === ACCESS_LOG_PAGE)
      } catch (err) {
        if (my !== seq.current) return
        setError(err?.message || 'โหลดประวัติไม่สำเร็จ')
        if (!append) setRows([])
        setMore(false)
      } finally {
        if (my === seq.current) setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters, rows],
  )

  // a filter change reloads from the newest row
  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }))

  // the WHOLE filtered result (all pages, up to EXPORT_MAX rows), not only what is on screen
  const [exporting, setExporting] = useState(false)
  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    let all = []
    let capped = false
    try {
      let beforeId
      for (;;) {
        const page = await fetchFileAccessLog({ ...filters, beforeId })
        all = all.concat(page)
        if (page.length < ACCESS_LOG_PAGE) break
        if (all.length >= EXPORT_MAX) {
          capped = true
          break
        }
        beforeId = page[page.length - 1].id
      }
    } catch (err) {
      setExporting(false)
      setNotice(`ส่งออก CSV ไม่สำเร็จ: ${err?.message || ''}`)
      return
    }
    setExporting(false)
    setNotice('')
    if (capped) setNotice(`ส่งออกได้ ${EXPORT_MAX.toLocaleString()} รายการล่าสุดเท่านั้น — กรองช่วงวันที่ให้แคบลงเพื่อส่งออกส่วนที่เหลือ`)
    const head = ['เวลา (เวลาไทย)', 'ผู้ใช้', 'อีเมล', 'การกระทำ', 'ไฟล์', 'โครงการ']
    const lines = [head, ...all.map((r) => [csvTime(r.at), r.user_name || '', r.user_email || '', ACCESS_ACTION_LABEL[r.action] || r.action, r.file_name || '', r.project_code || ''])]
    const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') // BOM: Excel reads Thai correctly
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `file-access-log_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  const sortedUsers = [...(users || [])].sort((a, b) => (a.full_name || a.email || '').localeCompare(b.full_name || b.email || '', 'th'))

  return (
    <Dialog
      title="ประวัติการเปิด/ดาวน์โหลดไฟล์"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            แสดง {rows.length} รายการ{more ? ' (มีเพิ่มเติม)' : ''} · เห็นได้เฉพาะผู้ดูแลระบบ · เก็บย้อนหลัง 1 ปี
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!rows.length || exporting} data-testid="access-csv">
            <Icon name="download" size={13} /> {exporting ? 'กำลังส่งออก…' : 'CSV ทั้งหมด'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            ปิด
          </button>
        </>
      }
    >
      <div className="acl-filters">
        <label className="field">
          <span>ผู้ใช้</span>
          <select value={filters.userId} onChange={set('userId')} data-testid="access-user">
            <option value="">ทุกคน</option>
            {sortedUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name ? `${u.full_name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>โครงการ</span>
          <select value={filters.projectId} onChange={set('projectId')} data-testid="access-project">
            <option value="">ทุกโครงการ</option>
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.code ? `${p.code} — ${p.name}` : p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>การกระทำ</span>
          <select value={filters.action} onChange={set('action')} data-testid="access-action">
            <option value="">ทั้งหมด</option>
            {Object.entries(ACCESS_ACTION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ตั้งแต่วันที่</span>
          <input type="date" value={filters.fromDate} onChange={set('fromDate')} />
        </label>
        <label className="field">
          <span>ถึงวันที่</span>
          <input type="date" value={filters.toDate} onChange={set('toDate')} />
        </label>
      </div>

      {notice && (
        <div className="acl-notice" role="status" data-testid="access-notice">
          {notice}
        </div>
      )}
      {error && (
        <div className="acl-notice acl-notice-err" role="alert">
          {error}
        </div>
      )}
      {error && rows.length === 0 ? null : !loading && rows.length === 0 ? (
        <div className="acl-msg muted">ยังไม่มีประวัติที่ตรงกับเงื่อนไข</div>
      ) : (
        <div className="acl-table-wrap">
          <table className="acl-table" data-testid="access-table">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผู้ใช้</th>
                <th>การกระทำ</th>
                <th>ไฟล์</th>
                <th>โครงการ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="access-row">
                  <td className="nowrap">{fmtThaiDateTime(r.at)}</td>
                  <td>
                    <div>{r.user_name || r.user_email || '-'}</div>
                    {r.user_name && <div className="muted small">{r.user_email}</div>}
                  </td>
                  <td className="nowrap">{ACCESS_ACTION_LABEL[r.action] || r.action}</td>
                  <td className="acl-file">{r.file_name || '-'}</td>
                  <td className="nowrap">{r.project_code || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted small" style={{ marginTop: 8 }}>
        "การกระทำ" คือสิ่งที่ผู้ใช้ขอจากระบบ (เช่น ขอเปิดดู) — ลิงก์ไฟล์ใช้ได้ประมาณ 5 นาที จึงอาจถูกบันทึกเป็นไฟล์ได้แม้ขอแค่เปิดดู ·
        การค้นหา / แชท AI อ่านเฉพาะข้อความที่สกัดจากเอกสาร ซึ่งไม่ถูกบันทึกในประวัตินี้
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
        {loading ? (
          <div className="spinner" aria-label="กำลังโหลด" />
        ) : more ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(true)} data-testid="access-more">
            โหลดเพิ่ม
          </button>
        ) : null}
      </div>
    </Dialog>
  )
}
