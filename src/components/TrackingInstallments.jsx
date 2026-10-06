import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import {
  createInstallment, updateInstallment, setInstallmentStatus, fetchInstallmentEvents,
} from '../api/supabase.js'
import {
  STATUS_FLOW, ALL_STATUSES, STATUS_LABEL, STATUS_TONE, installmentHeadline, installmentName, isBackwardMove,
  nextStatusInFlow, docsStateText, fmtThaiDate, fmtThaiDateTime, countdownText, todayTH, isIsoDate, isSaneDate, INSANE_DATE_MESSAGE,
} from '../utils/tracking.js'
import { ToneBadge } from './TrackingBits.jsx'
import TrackingChecklist from './TrackingChecklist.jsx'

// ---------- status stepper ----------
function Stepper({ status }) {
  const side = status === 'returned' || status === 'cancelled'
  const idx = STATUS_FLOW.indexOf(status)
  return (
    <div>
      <ol className={`trk-stepper ${side ? 'dim' : ''}`} aria-label="ขั้นตอนสถานะงวด">
        {STATUS_FLOW.map((s, i) => {
          const cls = side ? '' : i < idx ? 'done' : i === idx ? 'current' : ''
          return (
            <li key={s} className={cls} aria-current={!side && i === idx ? 'step' : undefined}>
              <span className="dot">{!side && i < idx ? <Icon name="check" size={11} stroke={3} /> : i + 1}</span>
              <span className="lbl">{STATUS_LABEL[s]}</span>
            </li>
          )
        })}
      </ol>
      {side && (
        <div className={`trk-side-state ${status}`}>
          <Icon name="alert" size={14} />
          {status === 'returned'
            ? 'สถานะปัจจุบัน: ตีกลับ — ต้องแก้ไข/เบิกใหม่ (เลือกสถานะถัดไปด้านล่างเมื่อดำเนินการแล้ว)'
            : 'สถานะปัจจุบัน: ยกเลิก — งวดนี้ไม่นับรวมในสรุป'}
        </div>
      )}
    </div>
  )
}

// ---------- event history ----------
function EventsPanel({ installmentId }) {
  const [state, setState] = useState({ loading: true, events: [], error: '' })
  useEffect(() => {
    let alive = true
    fetchInstallmentEvents(installmentId).then(
      (res) => alive && setState({ loading: false, events: res.data || [], error: res.error ? res.error.message : '' })
    )
    return () => {
      alive = false
    }
  }, [installmentId])
  if (state.loading) return <div className="muted small" style={{ padding: 8 }}>กำลังโหลดประวัติ...</div>
  if (state.error) return <div className="auth-msg err">โหลดประวัติไม่สำเร็จ: {state.error}</div>
  if (state.events.length === 0) return <div className="trk-empty">ยังไม่มีประวัติ</div>
  return (
    <ul className="trk-events">
      {state.events.map((ev) => (
        <li key={ev.id}>
          <div>
            <b>{ev.from_status ? `${STATUS_LABEL[ev.from_status] || ev.from_status} → ` : 'สร้างงวด · '}</b>
            <b>{STATUS_LABEL[ev.to_status] || ev.to_status}</b>
            {ev.note && <span className="trk-ev-note"> — “{ev.note}”</span>}
          </div>
          <div className="muted small">
            {fmtThaiDateTime(ev.created_at)} · โดย {ev.actor_name || 'ไม่ระบุ'}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------- one installment ----------
function InstallmentCard({ inst, open, onToggle, onChanged, onOpenUpload }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(inst.title || '')
  const [planned, setPlanned] = useState(inst.planned_bill_date || '')
  const [inote, setInote] = useState(inst.note || '')
  const [target, setTarget] = useState(nextStatusInFlow(inst.status))
  const [note, setNote] = useState('')
  // Default to the original billed date when there is one (e.g. approved/paid moved
  // back to billed) so it is not silently overwritten with today.
  const [billedDate, setBilledDate] = useState(inst.billed_date || todayTH())
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)

  // Re-seed the date whenever the target status or the stored billed_date changes.
  useEffect(() => {
    setBilledDate(inst.billed_date || todayTH())
  }, [inst.installment_id, inst.billed_date, target])

  const head = installmentHeadline(inst)
  const docs = docsStateText(inst.docs_state, inst.required_docs_total, inst.required_docs_attached)
  const today = todayTH()

  const startEdit = () => {
    setTitle(inst.title || '')
    setPlanned(inst.planned_bill_date || '')
    setInote(inst.note || '')
    setEditing(true)
  }

  const saveEdit = async (e) => {
    e.preventDefault()
    if (planned && !isIsoDate(planned)) {
      toast('รูปแบบวันที่ไม่ถูกต้อง', 'err')
      return
    }
    if (planned && !isSaneDate(planned)) {
      toast(INSANE_DATE_MESSAGE, 'err')
      return
    }
    setBusy(true)
    try {
      await updateInstallment(inst.installment_id, { title, plannedBillDate: planned, note: inote })
      toast('บันทึกงวดเรียบร้อย')
      setEditing(false)
      await onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (e) => {
    e.preventDefault()
    if (target === inst.status) return
    if (isBackwardMove(inst.status, target)) {
      const msg =
        target === 'cancelled'
          ? `ยืนยันยกเลิก ${installmentName(inst)}?`
          : `ย้อนสถานะ ${installmentName(inst)} จาก "${STATUS_LABEL[inst.status]}" เป็น "${STATUS_LABEL[target]}" ใช่หรือไม่?`
      if (!window.confirm(msg)) return
    }
    if ((target === 'ready_to_bill' || target === 'billed') && inst.docs_state === 'missing') {
      const miss = inst.required_docs_total - inst.required_docs_attached
      if (!window.confirm(`เอกสารจำเป็นยังขาด ${miss} รายการ — ต้องการเปลี่ยนเป็น "${STATUS_LABEL[target]}" ต่อหรือไม่?`)) return
    }
    if (target === 'billed') {
      if (!isIsoDate(billedDate)) {
        toast('รูปแบบวันที่เบิกไม่ถูกต้อง', 'err')
        return
      }
      if (!isSaneDate(billedDate)) {
        toast(INSANE_DATE_MESSAGE, 'err')
        return
      }
      if (billedDate > today) {
        toast('วันที่เบิกต้องไม่เกินวันนี้', 'err')
        return
      }
    }
    setBusy(true)
    try {
      await setInstallmentStatus(inst.installment_id, target, note, { billedDate })
      toast(`${installmentName(inst)}: ${STATUS_LABEL[target]}`)
      setNote('')
      setTarget(nextStatusInFlow(target))
      setHistoryKey((k) => k + 1)
      await onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const bodyId = `trk-inst-${inst.installment_id}`
  return (
    <div className={`trk-inst ${open ? 'open' : ''} ${inst.is_overdue ? 'overdue' : ''}`}>
      <button
        type="button"
        className="trk-inst-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="trk-inst-no">{inst.installment_no}</span>
        <span className="trk-inst-title">
          <span className={`trk-text-${head.tone}`}>{head.text}</span>
          {inst.title && <span className="muted small"> · {inst.title}</span>}
        </span>
        <span className="trk-inst-badges">
          <ToneBadge tone={STATUS_TONE[inst.status]}>{STATUS_LABEL[inst.status]}</ToneBadge>
          {inst.status !== 'cancelled' && (
            <ToneBadge tone={docs.tone}>
              {inst.docs_state === 'no_required_docs'
                ? docs.text
                : `เอกสาร ${inst.required_docs_attached}/${inst.required_docs_total}`}
            </ToneBadge>
          )}
          {inst.is_overdue && <ToneBadge tone="bad">เลยกำหนด</ToneBadge>}
        </span>
        <Icon name="chevron-down" size={16} className="trk-chev" />
      </button>

      {open && (
        <div className="trk-inst-body" id={bodyId}>
          {editing ? (
            <form className="trk-edit" onSubmit={saveEdit}>
              <div className="trk-form-row">
                <div className="field" style={{ flex: '2 1 220px' }}>
                  <label htmlFor={`t-${bodyId}`}>ชื่องวด / รายละเอียด</label>
                  <input id={`t-${bodyId}`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น ส่งมอบรายงานฉบับสมบูรณ์" />
                </div>
                <div className="field" style={{ flex: '1 1 170px' }}>
                  <label htmlFor={`d-${bodyId}`}>กำหนดเบิก</label>
                  <input id={`d-${bodyId}`} type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} />
                  <span className="muted small">{isIsoDate(planned) ? `= ${fmtThaiDate(planned, { long: true })}` : 'ยังไม่กำหนด'}</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor={`n-${bodyId}`}>หมายเหตุ</label>
                <input id={`n-${bodyId}`} value={inote} onChange={(e) => setInote(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                  <Icon name="check" size={13} /> บันทึก
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                  ยกเลิก
                </button>
              </div>
            </form>
          ) : (
            <div className="trk-inst-facts">
              <div>
                <span className="muted small">กำหนดเบิก</span>
                <div>
                  {inst.planned_bill_date ? (
                    <>
                      {fmtThaiDate(inst.planned_bill_date)}{' '}
                      {inst.days_until_planned != null && !inst.is_billed && inst.status !== 'cancelled' && (
                        <span className={inst.is_overdue ? 'trk-text-bad' : 'muted'}>({countdownText(inst.days_until_planned)})</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">ยังไม่กำหนด</span>
                  )}
                </div>
              </div>
              <div>
                <span className="muted small">วันที่เบิก</span>
                <div>{inst.is_billed && inst.billed_date ? fmtThaiDate(inst.billed_date) : <span className="muted">-</span>}</div>
              </div>
              <div>
                <span className="muted small">อยู่ในสถานะนี้</span>
                <div>{inst.days_in_status != null ? `${inst.days_in_status} วัน` : '-'}</div>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <span className="muted small">หมายเหตุ</span>
                <div>{inst.note || <span className="muted">-</span>}</div>
              </div>
              <button type="button" className="trk-link-btn" onClick={startEdit}>
                <Icon name="pen" size={13} /> แก้ไขชื่อ/วันที่
              </button>
            </div>
          )}

          <Stepper status={inst.status} />

          <form className="trk-status-form" onSubmit={changeStatus}>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor={`s-${bodyId}`}>เปลี่ยนสถานะ</label>
              <select id={`s-${bodyId}`} value={target} onChange={(e) => setTarget(e.target.value)}>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                    {s === inst.status ? ' (ปัจจุบัน)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {target === 'billed' && inst.status !== 'billed' && (
              <div className="field" style={{ flex: '0 1 160px' }}>
                <label htmlFor={`b-${bodyId}`}>วันที่เบิก</label>
                <input id={`b-${bodyId}`} type="date" value={billedDate} max={today} onChange={(e) => setBilledDate(e.target.value)} />
              </div>
            )}
            <div className="field" style={{ flex: '2 1 220px' }}>
              <label htmlFor={`m-${bodyId}`}>หมายเหตุ (ไม่บังคับ)</label>
              <input id={`m-${bodyId}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ส่งเอกสารเบิกให้ผู้ว่าจ้างแล้ว" />
            </div>
            <button type="submit" className="btn btn-primary btn-sm trk-status-btn" disabled={busy || target === inst.status}>
              <Icon name="check" size={13} /> บันทึกสถานะ
            </button>
          </form>

          <div className="trk-hist-bar">
            <div className="muted small">
              แก้ไขล่าสุดโดย {inst.updated_by || 'ไม่ระบุ'} · {fmtThaiDateTime(inst.updated_at)}
            </div>
            <button type="button" className="trk-link-btn" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
              <Icon name="history" size={13} /> ประวัติสถานะ
            </button>
          </div>
          {showHistory && (
            <div className="trk-hist-panel">
              <EventsPanel key={historyKey} installmentId={inst.installment_id} />
            </div>
          )}

          <TrackingChecklist
            installment={inst}
            projectId={inst.project_id}
            onChanged={onChanged}
            onOpenUpload={onOpenUpload}
          />
        </div>
      )}
    </div>
  )
}

// ---------- list ----------
export default function TrackingInstallments({ installments, projectId, onChanged, onOpenUpload }) {
  const toast = useToast()
  // Start with the first installment still to bill expanded; the choice is then
  // pinned so it does not collapse when that installment's status changes.
  const [openId, setOpenId] = useState(() => (installments.find((i) => i.is_open_to_bill) || {}).installment_id || null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [planned, setPlanned] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (e) => {
    e.preventDefault()
    if (planned && !isIsoDate(planned)) {
      toast('รูปแบบวันที่ไม่ถูกต้อง', 'err')
      return
    }
    if (planned && !isSaneDate(planned)) {
      toast(INSANE_DATE_MESSAGE, 'err')
      return
    }
    setBusy(true)
    try {
      const row = await createInstallment(projectId, { title, plannedBillDate: planned })
      toast(`เพิ่ม งวดที่ ${row.installment_no} แล้ว`)
      setTitle('')
      setPlanned('')
      setAdding(false)
      setOpenId(row.id)
      await onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const billed = installments.filter((i) => i.is_billed).length
  const counted = installments.filter((i) => i.status !== 'cancelled').length

  return (
    <div className="card trk-panel">
      <div className="trk-panel-head">
        <h3 className="trk-panel-h" style={{ margin: 0 }}>
          <Icon name="layers" size={16} /> งวดงาน / งวดเบิก
          {counted > 0 && <span className="muted small" style={{ fontWeight: 400 }}> · เบิกแล้ว {billed}/{counted} งวด</span>}
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <Icon name="plus" size={13} /> เพิ่มงวด
        </button>
      </div>

      {adding && (
        <form className="trk-edit" onSubmit={add}>
          <div className="trk-form-row">
            <div className="field" style={{ flex: '2 1 220px' }}>
              <label htmlFor="trk-new-title">ชื่องวด / รายละเอียด (ไม่บังคับ)</label>
              <input id="trk-new-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น ส่งมอบรายงานฉบับสมบูรณ์" autoFocus />
            </div>
            <div className="field" style={{ flex: '1 1 170px' }}>
              <label htmlFor="trk-new-date">กำหนดเบิก (ไม่บังคับ)</label>
              <input id="trk-new-date" type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} />
              <span className="muted small">{isIsoDate(planned) ? `= ${fmtThaiDate(planned, { long: true })}` : ''}</span>
            </div>
          </div>
          <div className="muted small" style={{ marginBottom: 10 }}>
            เลขงวดรันให้อัตโนมัติ (งวดที่ {(installments.reduce((m, i) => Math.max(m, i.installment_no), 0)) + 1}) ·
            เช็กลิสต์จะถูกคัดลอกจากแม่แบบของโครงการ
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              <Icon name="check" size={13} /> {busy ? 'กำลังเพิ่ม...' : 'เพิ่มงวด'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)} disabled={busy}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}

      {installments.length === 0 ? (
        <div className="trk-empty">ยังไม่มีงวดงาน — กด "เพิ่มงวด" เพื่อเริ่มติดตามการเบิก</div>
      ) : (
        <div className="trk-inst-list">
          {installments.map((inst) => (
            <InstallmentCard
              key={inst.installment_id}
              inst={inst}
              open={openId === inst.installment_id}
              onToggle={() => setOpenId(openId === inst.installment_id ? null : inst.installment_id)}
              onChanged={onChanged}
              onOpenUpload={onOpenUpload}
            />
          ))}
        </div>
      )}
    </div>
  )
}
