import { useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Dialog, { ConfirmDialog } from './ui/Dialog.jsx'
import { adminCreateUser } from '../api/supabase.js'
import { ROLES, ROLE_LABEL, ROLE_DESC } from '../utils/roles.js'
import { fmtThaiDateTime } from '../utils/tracking.js'

// Clipboard with a fallback for browsers/contexts where navigator.clipboard is unavailable.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

// Create account. On success the parent gets { user, temporaryPassword } and shows it ONCE.
export function CreateUserDialog({ onClose, onCreated }) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false) // synchronous guard: a double click / double Enter creates ONE account
  // 409 orphan_auth_user: a sign-in account with this e-mail exists but has no profile. The admin has to confirm
  // taking it over (its password is replaced) before the same request is sent again with adoptExisting.
  const [orphan, setOrphan] = useState(null) // { message, lastSignInAt }
  const [orphanError, setOrphanError] = useState('')

  const create = async (adoptExisting) => {
    if (busy || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setOrphanError('')
    try {
      const res = await adminCreateUser({ email: email.trim(), fullName: fullName.trim(), role, adoptExisting })
      onCreated(res)
    } catch (err) {
      if (err?.code === 'orphan_auth_user' && !adoptExisting) {
        setOrphan({ message: err.serverMessage || err.message, lastSignInAt: err.lastSignInAt ?? null })
      } else if (adoptExisting) {
        setOrphanError(err?.message || 'สร้างบัญชีไม่สำเร็จ')
      } else {
        setError(err?.message || 'สร้างบัญชีไม่สำเร็จ')
      }
      busyRef.current = false
      setBusy(false)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy || busyRef.current) return
    if (!email.trim()) return setError('กรุณากรอกอีเมล')
    if (!fullName.trim()) return setError('กรุณากรอกชื่อ-นามสกุล')
    await create(false)
  }

  return (
    <Dialog title="เพิ่มผู้ใช้ใหม่" onClose={busy ? undefined : onClose} closable={!busy}>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="cu-email">อีเมล (ใช้เป็นชื่อผู้ใช้เข้าสู่ระบบ)</label>
            <input
              id="cu-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="cu-name">ชื่อ-นามสกุล</label>
            <input id="cu-name" autoComplete="off" value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={busy} required />
          </div>
          <div className="field" style={{ marginBottom: 6 }}>
            <label htmlFor="cu-role">บทบาท</label>
            <select id="cu-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy} aria-describedby="cu-role-desc">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="muted small" id="cu-role-desc" style={{ marginBottom: 12 }}>
            {ROLE_DESC[role]}
            {role === 'user' && ' — กำหนดโครงการที่เข้าถึงได้หลังสร้างบัญชี'}
          </div>
          <div className="adm-note">
            <Icon name="info" size={14} />
            <span>
              ระบบจะสร้าง <b>รหัสผ่านชั่วคราว</b> ให้และแสดง <b>เพียงครั้งเดียว</b> — ส่งให้ผู้ใช้ด้วยตัวเอง (ระบบไม่ส่งอีเมล) ผู้ใช้จะต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก
            </span>
          </div>
          {error && (
            <div className="auth-msg err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Icon name="plus" size={14} /> {busy ? 'กำลังสร้าง...' : 'สร้างบัญชี'}
          </button>
        </div>
      </form>
      {orphan && (
        <ConfirmDialog
          title="มีบัญชีเข้าสู่ระบบอยู่แล้วแต่ยังไม่มีโปรไฟล์"
          confirmLabel="ใช้บัญชีนี้และออกรหัสผ่านชั่วคราวใหม่"
          danger
          busy={busy}
          error={orphanError}
          onConfirm={() => create(true)}
          onCancel={() => {
            setOrphan(null)
            setOrphanError('')
          }}
        >
          <p style={{ marginTop: 0 }} data-testid="orphan-message">{orphan.message}</p>
          <p className="small" style={{ margin: '0 0 10px' }} data-testid="orphan-last-signin">
            เข้าสู่ระบบล่าสุด: <b>{orphan.lastSignInAt ? fmtThaiDateTime(orphan.lastSignInAt) : 'ยังไม่เคย'}</b>
          </p>
          <div className="adm-note warn" style={{ marginBottom: 0 }}>
            <Icon name="alert" size={14} />
            <span>
              หากดำเนินการต่อ <b>รหัสผ่านเดิมของบัญชีนี้จะถูกแทนที่</b> ด้วยรหัสผ่านชั่วคราวใหม่ และผู้ใช้ต้องตั้งรหัสผ่านใหม่เองเมื่อเข้าสู่ระบบครั้งแรก
            </span>
          </div>
        </ConfirmDialog>
      )}
    </Dialog>
  )
}

// Shows a temporary password exactly once. Not closable by Escape/backdrop: the admin has to
// press the button, so the password cannot disappear by accident. Nothing here is persisted.
export function TempPasswordDialog({ secret, onClose }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const isReset = secret.kind === 'reset'

  const copy = async () => {
    const ok = await copyText(secret.password)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  return (
    <Dialog
      title={isReset ? 'รีเซ็ตรหัสผ่านแล้ว' : 'สร้างบัญชีเรียบร้อย'}
      closable={false}
      size="sm"
      initialFocus="[data-copy]"
      describedBy="tp-warn"
      footer={
        <button type="button" className={`btn ${copied ? 'btn-primary' : 'btn-ghost'}`} onClick={onClose} data-testid="temp-password-close">
          {copied ? 'ปิด' : 'ปิดโดยยังไม่ได้คัดลอก'}
        </button>
      }
    >
      <div className="modal-body" data-testid="temp-password-dialog">
        <div className="small muted">บัญชี</div>
        <div style={{ marginBottom: 12 }}>
          <b>{secret.name || secret.email}</b>
          {secret.name && <span className="muted"> · {secret.email}</span>}
        </div>

        <div className="small muted">รหัสผ่านชั่วคราว</div>
        <div className="temp-pw-row">
          <code className="temp-pw" data-testid="temp-password" aria-label="รหัสผ่านชั่วคราว">
            {secret.password}
          </code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy} data-copy>
            <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
          </button>
        </div>
        <div role="status" className="small" style={{ minHeight: 18 }}>
          {copyFailed && <span className="trk-text-bad">คัดลอกอัตโนมัติไม่ได้ — เลือกข้อความรหัสผ่านแล้วคัดลอกด้วยตนเอง</span>}
        </div>

        <div className="auth-msg err" id="tp-warn" style={{ marginTop: 8, marginBottom: 10 }}>
          <b>รหัสผ่านนี้จะไม่แสดงอีก</b> — คัดลอกและส่งให้ผู้ใช้ทางช่องทางที่ปลอดภัยก่อนปิดหน้าต่างนี้ หากทำหาย ให้ใช้ "รีเซ็ตรหัสผ่าน" เพื่อออกรหัสใหม่
        </div>
        <div className="muted small">
          {isReset
            ? 'รหัสผ่านเดิมใช้ไม่ได้แล้ว ผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบด้วยรหัสชั่วคราวนี้'
            : 'ผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก'}
        </div>
        {(secret.sessionsRevoked === false || secret.audit === false) && (
          <div className="adm-note warn" role="status" style={{ marginTop: 10, marginBottom: 0 }} data-testid="temp-password-notes">
            <Icon name="alert" size={14} />
            <span>
              {isReset && secret.sessionsRevoked === false && (
                <span style={{ display: 'block' }}>ระบบยังไม่ได้ออกจากระบบอุปกรณ์เดิมของผู้ใช้ — เซสชันเดิมอาจใช้งานได้จนหมดอายุ</span>
              )}
              {secret.audit === false && (
                <span style={{ display: 'block' }}>บันทึกประวัติการเปลี่ยนแปลง (audit) ไม่สำเร็จ — โปรดแจ้งผู้ดูแลฐานข้อมูล</span>
              )}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
