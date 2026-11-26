import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { ConfirmDialog } from './ui/Dialog.jsx'
import { useToast } from './Toast.jsx'
import {
  createInstallment, updateInstallment, setInstallmentStatus, deleteInstallment,
} from '../api/supabase.js'
import {
  STATUS_FLOW, ALL_STATUSES, STATUS_LABEL, STATUS_TONE, installmentHeadline, installmentName, isBackwardMove,
  docsStateText, fmtThaiDate, fmtThaiDateTime, countdownText, todayTH, isIsoDate, isSaneDate, INSANE_DATE_MESSAGE,
  NO_INSTALLMENTS_LABEL, NO_INSTALLMENTS_NOTE,
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

// ---------- one installment ----------
function InstallmentCard({ inst, open, canEdit, onToggle, onChanged, onDeleted, onOpenUpload }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [no, setNo] = useState(String(inst.installment_no))
  const [title, setTitle] = useState(inst.title || '')
  const [planned, setPlanned] = useState(inst.planned_bill_date || '')
  const [inote, setInote] = useState(inst.note || '')
  // The status form always starts on the CURRENT status, so "save" works at any
  // time (it then just persists the note / billed date).
  const [target, setTarget] = useState(inst.status)
  // status_note is the installment's persistent "หมายเหตุสถานะ" (no history any more).
  const [note, setNote] = useState(inst.status_note || '')
  // Prefilled with the stored billed date (e.g. approved/paid moved back to billed)
  // so it is never silently overwritten with today.
  const [billedDate, setBilledDate] = useState(inst.billed_date || todayTH())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTarget(inst.status)
  }, [inst.installment_id, inst.status])
  useEffect(() => {
    setNote(inst.status_note || '')
  }, [inst.installment_id, inst.status_note])
  // Re-seed the date whenever the target status or the stored billed_date changes.
  useEffect(() => {
    setBilledDate(inst.billed_date || todayTH())
  }, [inst.installment_id, inst.billed_date, target])

  const head = installmentHeadline(inst)
  const docs = docsStateText(inst.docs_state, inst.required_docs_total, inst.required_docs_attached)
  const today = todayTH()

  const startEdit = () => {
    setNo(String(inst.installment_no))
    setTitle(inst.title || '')
    setPlanned(inst.planned_bill_date || '')
    setInote(inst.note || '')
    setEditing(true)
  }

  const saveEdit = async (e) => {
    e.preventDefault()
    const rawNo = String(no).trim()
    const n = Number(rawNo)
    if (rawNo === '' || !Number.isInteger(n) || n < 1) {
      toast('งวดที่ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป', 'err')
      return
    }
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
      const changes = { title, plannedBillDate: planned, note: inote }
      if (n !== inst.installment_no) changes.installmentNo = n
      await updateInstallment(inst.installment_id, changes)
      toast('บันทึกงวดเรียบร้อย')
      setEditing(false)
      await onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const billedWarn = inst.is_billed ? `\nงวดนี้อยู่ในสถานะ "${STATUS_LABEL[inst.status]}" แล้ว\n` : ''
    const msg =
      `ลบ ${installmentName(inst)}${inst.title ? ` (${inst.title})` : ''} ถาวรใช่หรือไม่?\n${billedWarn}\n` +
      'ระบบจะลบงวดนี้และเช็กลิสต์เอกสารของงวดนี้ทั้งหมด ย้อนกลับไม่ได้ (ตัวไฟล์เอกสารยังอยู่ในระบบ ไม่ถูกลบ)'
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      await deleteInstallment(inst.installment_id)
      toast(`ลบ ${installmentName(inst)} แล้ว`)
      onDeleted?.(inst.installment_id)
      await onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (e) => {
    e.preventDefault()
    const changing = target !== inst.status
    if (changing && isBackwardMove(inst.status, target)) {
      const msg =
        target === 'cancelled'
          ? `ยืนยันยกเลิก ${installmentName(inst)}?`
          : `ย้อนสถานะ ${installmentName(inst)} จาก "${STATUS_LABEL[inst.status]}" เป็น "${STATUS_LABEL[target]}" ใช่หรือไม่?`
      if (!window.confirm(msg)) return
    }
    if (changing && (target === 'ready_to_bill' || target === 'billed') && inst.docs_state === 'missing') {
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
      toast(`บันทึกสถานะแล้ว — ${installmentName(inst)}: ${STATUS_LABEL[target]}`)
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
          {editing && canEdit ? (
            <form className="trk-edit" onSubmit={saveEdit} noValidate>
              <div className="trk-form-row">
                <div className="field" style={{ flex: '0 1 100px' }}>
                  <label htmlFor={`no-${bodyId}`}>งวดที่</label>
                  <input
                    id={`no-${bodyId}`}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={no}
                    onChange={(e) => setNo(e.target.value)}
                  />
                </div>
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
                <label htmlFor={`n-${bodyId}`}>หมายเหตุทั่วไป</label>
                <input id={`n-${bodyId}`} value={inote} onChange={(e) => setInote(e.target.value)} />
              </div>
              <div className="trk-edit-actions">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                  <Icon name="check" size={13} /> บันทึก
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                  ยกเลิก
                </button>
                <button type="button" className="trk-danger-btn" onClick={remove} disabled={busy}>
                  <Icon name="trash" size={13} /> ลบงวด
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
                <span className="muted small">หมายเหตุสถานะ</span>
                <div>{inst.status_note || <span className="muted">-</span>}</div>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <span className="muted small">หมายเหตุทั่วไป</span>
                <div>{inst.note || <span className="muted">-</span>}</div>
              </div>
              {canEdit && (
                <button type="button" className="trk-link-btn" onClick={startEdit}>
                  <Icon name="pen" size={13} /> แก้ไขงวด
                </button>
              )}
            </div>
          )}

          <Stepper status={inst.status} />

          {canEdit && (
          <form className="trk-status-form" onSubmit={changeStatus}>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor={`s-${bodyId}`}>เปลี่ยนสถานะ</label>
              <select
                id={`s-${bodyId}`}
                value={target}
                onChange={(e) => {
                  const next = e.target.value
                  // the saved note belongs to the saved status: don't carry it onto another one
                  if (next !== inst.status && note === (inst.status_note || '')) setNote('')
                  if (next === inst.status) setNote(inst.status_note || '')
                  setTarget(next)
                }}
              >
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                    {s === inst.status ? ' (ปัจจุบัน)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {target === 'billed' && (
              <div className="field" style={{ flex: '0 1 160px' }}>
                <label htmlFor={`b-${bodyId}`}>วันที่เบิก</label>
                <input id={`b-${bodyId}`} type="date" value={billedDate} max={today} onChange={(e) => setBilledDate(e.target.value)} />
              </div>
            )}
            <div className="field" style={{ flex: '2 1 220px' }}>
              <label htmlFor={`m-${bodyId}`}>หมายเหตุสถานะ (ไม่บังคับ)</label>
              <input id={`m-${bodyId}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ส่งเอกสารเบิกให้ผู้ว่าจ้างแล้ว" />
            </div>
            <button type="submit" className="btn btn-primary btn-sm trk-status-btn" disabled={busy}>
              <Icon name="check" size={13} /> บันทึกสถานะ
            </button>
          </form>
          )}

          <div className="muted small">แก้ไขล่าสุด {fmtThaiDateTime(inst.updated_at)}</div>

          <TrackingChecklist
            installment={inst}
            projectId={inst.project_id}
            canEdit={canEdit}
            onChanged={onChanged}
            onOpenUpload={onOpenUpload}
          />
        </div>
      )}
    </div>
  )
}

// ---------- "โครงการนี้ไม่มีงวดเบิก" switch (projects.has_installments) ----------
// Checked = the project has NO billing installments. Rendered only for admins and the project's manager.
// Turning it on while (non-cancelled) installments exist asks first (they are hidden and not counted,
// never deleted). One write at a time: a ref lock + aria-disabled (NOT `disabled`, which would drop the
// keyboard focus); focus is put back on the checkbox after every save / cancel.
function NoBillingSwitch({ hasInstallments, storedCount, onSet }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const lock = useRef(false)
  const inputRef = useRef(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // after the dialog has unmounted (it may restore focus elsewhere) and after the panel re-rendered
  const refocus = () => setTimeout(() => { if (mounted.current) inputRef.current?.focus() }, 0)

  const write = async (value) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    let ok = false
    try {
      await onSet(value)
      ok = true
      toast(value ? 'เปิดใช้งวดเบิกของโครงการนี้แล้ว' : 'ตั้งค่าแล้ว: โครงการนี้ไม่มีงวดเบิก')
    } catch (err) {
      if (mounted.current) setError(err?.message || 'บันทึกไม่สำเร็จ')
      // refused because this person is no longer admin / manager: the access re-read that follows removes
      // the switch (and this inline message with it), so say it in a toast as well
      if (err?.code === 'forbidden') toast(err.message, 'err')
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(false)
        if (ok) setConfirming(false)
        if (ok || !confirming) refocus()
      }
    }
  }

  const onChange = (e) => {
    if (lock.current) return // saving: the controlled checkbox simply keeps its state
    const noBilling = e.target.checked
    setError('')
    if (noBilling && storedCount > 0) setConfirming(true)
    else write(!noBilling)
  }

  return (
    <div className="trk-billing-switch-wrap">
      <label className="trk-billing-switch">
        <input
          ref={inputRef}
          type="checkbox"
          checked={!hasInstallments}
          aria-disabled={busy || undefined}
          onChange={onChange}
          data-testid="no-billing-toggle"
          aria-describedby="trk-billing-hint"
        />
        <span>โครงการนี้ไม่มีงวดเบิก</span>
        {busy && <span className="muted small" role="status">กำลังบันทึก...</span>}
      </label>
      <div className="muted small" id="trk-billing-hint">
        {hasInstallments
          ? 'ติ๊กเมื่อโครงการไม่มีงวดเบิกเลย — ระบบจะไม่นำงวดมาคิดสถานะแดง/เหลือง (เฉพาะแอดมิน / ผู้ดูแลโครงการ)'
          : 'เอาติ๊กออกเพื่อกลับมาใช้งวดเบิก (งวดที่บันทึกไว้จะกลับมาแสดง)'}
      </div>
      {error && !confirming && (
        <div className="auth-msg err" role="alert" style={{ marginTop: 8, marginBottom: 0 }} data-testid="no-billing-error">
          {error}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="ตั้งค่าเป็น โครงการนี้ไม่มีงวดเบิก?"
          confirmLabel="ยืนยัน ไม่มีงวดเบิก"
          busy={busy}
          error={error}
          onConfirm={() => write(false)}
          onCancel={() => {
            setConfirming(false)
            setError('')
            refocus()
          }}
        >
          <p style={{ margin: 0 }} data-testid="no-billing-confirm-text">
            งวดที่มีอยู่ {storedCount} งวดจะถูกซ่อนและไม่นำมาคิดสถานะ — ข้อมูลยังเก็บไว้ เปิดกลับได้
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}

// ---------- list ----------
// hasInstallments=false: the project is set to "no billing installments" -> only a muted note (and the
// switch for people who may edit) instead of the list, the add form and the checklists / templates.
export default function TrackingInstallments({
  installments, projectId, canEdit = false, onChanged, onOpenUpload, hasInstallments = true, onSetHasInstallments,
}) {
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
  // The switch keeps ONE position in both states (right under the header), so toggling never re-mounts it
  // and the keyboard focus stays on it.
  const billingSwitch = onSetHasInstallments ? (
    <NoBillingSwitch key="billing-switch" hasInstallments={hasInstallments} storedCount={counted} onSet={onSetHasInstallments} />
  ) : null

  return (
    <div className="card trk-panel" data-testid="installments-panel">
      <div className="trk-panel-head">
        <h3 className="trk-panel-h" style={{ margin: 0 }}>
          <Icon name="layers" size={16} /> งวดงาน / งวดเบิก
          {hasInstallments && counted > 0 && (
            <span className="muted small" style={{ fontWeight: 400 }}> · เบิกแล้ว {billed}/{counted} งวด</span>
          )}
        </h3>
        {!hasInstallments ? (
          <ToneBadge tone="mute">{NO_INSTALLMENTS_LABEL}</ToneBadge>
        ) : (
          canEdit && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              <Icon name="plus" size={13} /> เพิ่มงวด
            </button>
          )
        )}
      </div>

      {billingSwitch}

      {!hasInstallments ? (
        <div className="trk-empty trk-no-billing" data-testid="no-billing-note">
          {NO_INSTALLMENTS_NOTE}
          <div className="small" style={{ marginTop: 4 }}>
            ไม่นำงวดเบิกมาคิดสถานะของโครงการ
            {canEdit && counted > 0 ? ` · งวดที่บันทึกไว้ ${counted} งวดถูกซ่อนไว้ (ข้อมูลยังเก็บไว้)` : ''}
          </div>
        </div>
      ) : (
      <>
      {adding && canEdit && (
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
            เลขงวดรันให้อัตโนมัติ (งวดที่ {(installments.reduce((m, i) => Math.max(m, i.installment_no), 0)) + 1} — แก้เลขงวดภายหลังได้) ·
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
        <div className="trk-empty">
          {canEdit ? 'ยังไม่มีงวดงาน — กด "เพิ่มงวด" เพื่อเริ่มติดตามการเบิก' : 'ยังไม่มีงวดงาน'}
        </div>
      ) : (
        <div className="trk-inst-list">
          {installments.map((inst) => (
            <InstallmentCard
              key={inst.installment_id}
              inst={inst}
              open={openId === inst.installment_id}
              canEdit={canEdit}
              onToggle={() => setOpenId(openId === inst.installment_id ? null : inst.installment_id)}
              onChanged={onChanged}
              onDeleted={(id) => setOpenId((cur) => (cur === id ? null : cur))}
              onOpenUpload={onOpenUpload}
            />
          ))}
        </div>
      )}
      </>
      )}
    </div>
  )
}
