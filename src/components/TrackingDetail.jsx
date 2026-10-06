import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import {
  fetchProjectTrackingRow, fetchProgressHistory, fetchInstallments, updateProjectTracking,
} from '../api/supabase.js'
import { getLocalName } from '../utils/localIdentity.js'
import { computeHealth, fmtThaiDate, isIsoDate, isSaneDate, isMine, INSANE_DATE_MESSAGE } from '../utils/tracking.js'
import { HealthChip, ToneBadge, NotInstalledNotice, ErrorNotice } from './TrackingBits.jsx'
import TrackingProgress from './TrackingProgress.jsx'
import TrackingInstallments from './TrackingInstallments.jsx'

function ProjectHeader({ row, health, onSaved }) {
  const toast = useToast()
  const localName = getLocalName()
  const [editing, setEditing] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [co, setCo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const startEdit = () => {
    setStart(row.start_date || '')
    setEnd(row.end_date || '')
    setCo(row.project_co || '')
    setError('')
    setEditing(true)
  }

  const save = async (e) => {
    e.preventDefault()
    setError('')
    if (start && !isIsoDate(start)) return setError('วันเริ่มสัญญาไม่ถูกต้อง')
    if (end && !isIsoDate(end)) return setError('วันสิ้นสุดสัญญาไม่ถูกต้อง')
    if (start && !isSaneDate(start)) return setError(`วันเริ่มสัญญา: ${INSANE_DATE_MESSAGE}`)
    if (end && !isSaneDate(end)) return setError(`วันสิ้นสุดสัญญา: ${INSANE_DATE_MESSAGE}`)
    if (start && end && end < start) return setError('วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่มสัญญา')
    setSaving(true)
    try {
      await updateProjectTracking(row.project_id, { start_date: start, end_date: end, project_co: co })
      toast('บันทึกข้อมูลโครงการเรียบร้อย')
      setEditing(false)
      await onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const mine = isMine(row.project_co, localName)
  const days = row.days_to_end

  return (
    <div className="card trk-head">
      <div className="trk-head-top">
        <HealthChip level={health.level} size="lg" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="trk-head-name">{row.project_name}</h2>
          <div className="trk-sub">
            <span>{row.project_code}</span>
            {row.project_status && <span>{row.project_status}</span>}
          </div>
        </div>
        {!editing && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={startEdit}>
            <Icon name="pen" size={13} /> แก้ไขสัญญา / Project Co
          </button>
        )}
      </div>

      {health.reasons.length > 0 && (
        <div className="trk-reasons">
          <Icon name="info" size={13} /> {health.reasons.join(' · ')}
        </div>
      )}

      {editing ? (
        <form className="trk-edit" onSubmit={save} noValidate>
          <div className="trk-form-row">
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor="trk-start">วันเริ่มสัญญา</label>
              <input id="trk-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              <span className="muted small">{isIsoDate(start) ? `= ${fmtThaiDate(start, { long: true })}` : 'ยังไม่ระบุ'}</span>
            </div>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor="trk-end">วันสิ้นสุดสัญญา</label>
              <input id="trk-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
              <span className="muted small">{isIsoDate(end) ? `= ${fmtThaiDate(end, { long: true })}` : 'ยังไม่ระบุ'}</span>
            </div>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <label htmlFor="trk-co">Project Co (ชื่อที่แสดง)</label>
              <input id="trk-co" value={co} onChange={(e) => setCo(e.target.value)} placeholder="ชื่อ-สกุล หรือรหัสพนักงาน (หลายคนคั่นด้วย ,)" />
              {localName && (
                <button type="button" className="trk-link-btn" onClick={() => setCo(localName)}>
                  ใช้ชื่อของฉัน ("{localName}")
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="auth-msg err" role="alert">
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              <Icon name="check" size={13} /> {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>
              ยกเลิก
            </button>
          </div>
        </form>
      ) : (
        <div className="trk-facts">
          <div>
            <span className="muted small">Project Co</span>
            <div>
              {row.project_co || <span className="muted">ยังไม่ระบุ</span>} {mine && <ToneBadge tone="info">คุณ</ToneBadge>}
            </div>
          </div>
          <div>
            <span className="muted small">เริ่มสัญญา</span>
            <div>{row.start_date ? fmtThaiDate(row.start_date) : <span className="muted">ยังไม่ระบุ</span>}</div>
          </div>
          <div>
            <span className="muted small">สิ้นสุดสัญญา</span>
            <div>
              {row.end_date ? fmtThaiDate(row.end_date) : <span className="muted">ยังไม่ระบุ</span>}
              {row.end_date && days != null && (
                <span className={days < 0 ? 'trk-text-bad' : 'muted'}>
                  {' '}({days < 0 ? `เกินสัญญา ${-days} วัน` : days === 0 ? 'ครบวันนี้' : `เหลือ ${days} วัน`})
                </span>
              )}
            </div>
          </div>
          <div>
            <span className="muted small">เวลาผ่านไป</span>
            <div>
              {row.time_elapsed_pct == null ? <span className="muted">- (ใส่วันที่สัญญา)</span> : <b>{row.time_elapsed_pct}%</b>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function TrackingDetail({ projectId, onBack, onOpenUpload }) {
  const [status, setStatus] = useState('loading') // loading | ready | notInstalled | missing | error
  const [errMsg, setErrMsg] = useState('')
  const [row, setRow] = useState(null)
  const [history, setHistory] = useState([])
  const [installments, setInstallments] = useState([])
  const toast = useToast()

  const loadAll = async () => {
    setStatus('loading')
    const [r, h, i] = await Promise.all([
      fetchProjectTrackingRow(projectId),
      fetchProgressHistory(projectId),
      fetchInstallments(projectId),
    ])
    if (r.notInstalled || h.notInstalled || i.notInstalled) return setStatus('notInstalled')
    const err = r.error || h.error || i.error
    if (err) {
      setErrMsg(err.message || '')
      return setStatus('error')
    }
    if (!r.data) return setStatus('missing')
    setRow(r.data)
    setHistory(h.data || [])
    setInstallments(i.data || [])
    setStatus('ready')
  }

  useEffect(() => {
    loadAll()
  }, [projectId])

  // partial refreshes keep the page (and the user's open forms) in place
  const refreshRow = async () => {
    const r = await fetchProjectTrackingRow(projectId)
    if (r.data) setRow(r.data)
    else if (r.error) toast('รีเฟรชข้อมูลโครงการไม่สำเร็จ: ' + r.error.message, 'err')
    return r
  }
  const refreshHistory = async () => {
    const h = await fetchProgressHistory(projectId)
    if (h.data) setHistory(h.data)
    else if (h.error) toast('รีเฟรชประวัติ % ไม่สำเร็จ: ' + h.error.message, 'err')
  }
  const refreshInstallments = async () => {
    const [i] = await Promise.all([fetchInstallments(projectId), refreshRow()])
    if (i.data) setInstallments(i.data)
    else if (i.error) toast('รีเฟรชงวดงานไม่สำเร็จ: ' + i.error.message, 'err')
  }

  const back = (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>
      <Icon name="arrow-l" size={14} /> กลับไปภาพรวมติดตามงาน
    </button>
  )

  let body
  if (status === 'loading' && !row) {
    body = (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: 280 }}>
        <div className="spinner" />
      </div>
    )
  } else if (status === 'notInstalled') {
    body = <NotInstalledNotice onRetry={loadAll} />
  } else if (status === 'error') {
    body = <ErrorNotice message={errMsg} onRetry={loadAll} />
  } else if (status === 'missing') {
    body = (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--gray-500)' }}>
        ไม่พบโครงการนี้ (อาจถูกลบแล้ว)
      </div>
    )
  } else if (row) {
    const rtbDays = installments
      .filter((i) => i.status === 'ready_to_bill')
      .reduce((m, i) => Math.max(m, i.days_in_status ?? 0), -1)
    const health = computeHealth(row, { readyToBillDays: rtbDays >= 0 ? rtbDays : null })
    body = (
      <>
        <ProjectHeader row={row} health={health} onSaved={refreshRow} />
        <div className="trk-detail-grid">
          <TrackingProgress row={row} history={history} onSaved={async () => { await Promise.all([refreshRow(), refreshHistory()]) }} />
          <TrackingInstallments
            installments={installments}
            projectId={projectId}
            onChanged={refreshInstallments}
            onOpenUpload={onOpenUpload}
          />
        </div>
      </>
    )
  }

  return (
    <section className="section">
      <div className="container">
        {back}
        {body}
      </div>
    </section>
  )
}
