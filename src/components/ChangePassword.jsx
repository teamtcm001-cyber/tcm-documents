import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Dialog from './ui/Dialog.jsx'
import { AuthBrand, PasswordField } from './LoginScreen.jsx'
import { useToast } from './Toast.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import {
  updatePassword, clearMustChangePassword, validateNewPassword, MIN_PASSWORD_LENGTH,
} from '../api/supabase.js'

// Shared form. `forced` = first login / password reset by an admin: after Supabase Auth has the new
// password, profiles.must_change_password is cleared through rpc('clear_must_change_password').
// If that second step fails the password HAS changed, so the retry only repeats step 2.
function PasswordChangeForm({ forced, email, onDone, onCancel, formId = 'pw' }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingClear, setPendingClear] = useState(false)
  const firstRef = useRef(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!pendingClear) {
      const msg = validateNewPassword(pw, confirm, { email })
      if (msg) {
        setError(msg)
        return
      }
    }
    setBusy(true)
    try {
      if (!pendingClear) {
        try {
          await updatePassword(pw)
        } catch (err) {
          if (!(forced && err?.code === 'same_password')) throw err
          // Half-done earlier attempt: Auth already has this password but must_change_password was never cleared,
          // so Supabase now rejects it as "same as the old one". Ask the server to clear the flag anyway; it
          // verifies that the password really was changed since the reset, and refuses otherwise.
          try {
            await clearMustChangePassword()
          } catch (clearErr) {
            setError(
              clearErr?.code === 'password_not_changed'
                ? 'รหัสผ่านนี้ซ้ำกับรหัสผ่านเดิม (หรือรหัสชั่วคราว) และระบบยังยืนยันไม่ได้ว่าได้ตั้งรหัสใหม่แล้ว — กรุณาตั้งรหัสผ่านอื่นที่ไม่ซ้ำกับรหัสที่ใช้เข้าสู่ระบบ'
                : clearErr?.message || 'ตรวจสอบสถานะไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
            )
            setBusy(false)
            return
          }
          setPw('')
          setConfirm('')
          await onDone?.()
          return
        }
      }
      if (forced) {
        try {
          await clearMustChangePassword()
        } catch (err) {
          if (err?.code === 'password_not_changed') {
            // the server checked and the password was NOT changed (clear_must_change_password raised PASSWORD_NOT_CHANGED)
            setPendingClear(false)
            setError('รหัสผ่านยังไม่ถูกเปลี่ยน กรุณาตั้งรหัสผ่านใหม่อีกครั้ง')
          } else if (err?.code === 'unauthorized') {
            // the session ended: retrying step 2 cannot work, the person has to sign in again
            setPendingClear(false)
            setError(err.message || 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
          } else {
            setPendingClear(true)
            setError('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว แต่ยังบันทึกสถานะไม่สำเร็จ กรุณากด "ลองอีกครั้ง" (ไม่ต้องกรอกรหัสผ่านซ้ำ)')
          }
          setBusy(false)
          return
        }
      }
      setPw('')
      setConfirm('')
      await onDone?.()
    } catch (err) {
      setError(err?.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setBusy(false)
    }
  }

  const hintId = `${formId}-hint`
  const errId = `${formId}-error`
  const mismatch = confirm.length > 0 && pw !== confirm

  return (
    <form onSubmit={submit} noValidate>
      {/* lets password managers attach the new password to the right account */}
      <input type="text" name="username" autoComplete="username" value={email || ''} readOnly hidden aria-hidden="true" tabIndex={-1} />
      <PasswordField
        id={`${formId}-new`}
        inputRef={firstRef}
        label="รหัสผ่านใหม่"
        value={pw}
        onChange={setPw}
        autoComplete="new-password"
        describedBy={`${hintId}${error ? ` ${errId}` : ''}`}
        invalid={!!error && !pendingClear}
        disabled={busy || pendingClear}
      />
      <div className="muted small pw-hint" id={hintId} style={{ marginTop: -6, marginBottom: 12 }}>
        อย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร (แนะนำให้ผสมตัวอักษรและตัวเลข) และไม่ซ้ำกับรหัสผ่านเดิม
      </div>
      <PasswordField
        id={`${formId}-confirm`}
        label="ยืนยันรหัสผ่านใหม่"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        invalid={mismatch}
        describedBy={mismatch ? `${formId}-mismatch` : undefined}
        disabled={busy || pendingClear}
      />
      {mismatch && (
        <div className="small trk-text-bad" id={`${formId}-mismatch`} style={{ marginTop: -8, marginBottom: 10 }}>
          รหัสผ่านทั้งสองช่องยังไม่ตรงกัน
        </div>
      )}

      {error && (
        <div className="auth-msg err" role="alert" id={errId}>
          {error}
        </div>
      )}

      <div className="pw-actions">
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          <Icon name="check" size={15} />
          {busy ? 'กำลังบันทึก...' : pendingClear ? 'ลองอีกครั้ง' : forced ? 'ตั้งรหัสผ่านและเข้าใช้งาน' : 'บันทึกรหัสผ่านใหม่'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            ยกเลิก
          </button>
        )}
      </div>
    </form>
  )
}

// Full page, no way around it: shown while profiles.must_change_password is true.
export function ForcedPasswordScreen() {
  const { profile, completePasswordChange, logout } = useAuth()
  const toast = useToast()
  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <main className="auth-card" aria-labelledby="forced-title">
        <AuthBrand />
        <h2 id="forced-title" className="auth-title">
          ตั้งรหัสผ่านใหม่
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          เพื่อความปลอดภัย กรุณาตั้งรหัสผ่านใหม่ของคุณเองก่อนเริ่มใช้งาน (รหัสผ่านชั่วคราวที่ได้รับจากผู้ดูแลระบบใช้ได้เพียงเพื่อเข้าสู่ระบบครั้งนี้)
        </p>
        {profile?.email && (
          <p className="small" style={{ marginTop: 0 }}>
            บัญชี: <b>{profile.email}</b>
          </p>
        )}
        <PasswordChangeForm
          forced
          formId="forced"
          email={profile?.email}
          onDone={async () => {
            toast('ตั้งรหัสผ่านใหม่เรียบร้อย')
            await completePasswordChange()
          }}
        />
        <button type="button" className="link-btn auth-link" onClick={logout}>
          ออกจากระบบ
        </button>
      </main>
    </div>
  )
}

// Voluntary change from the account menu.
export function ChangePasswordDialog({ onClose }) {
  const { profile } = useAuth()
  const toast = useToast()
  return (
    <Dialog title="เปลี่ยนรหัสผ่าน" onClose={onClose} size="sm">
      <div className="modal-body">
        <PasswordChangeForm
          formId="chg"
          email={profile?.email}
          onCancel={onClose}
          onDone={() => {
            toast('เปลี่ยนรหัสผ่านเรียบร้อย')
            onClose()
          }}
        />
      </div>
    </Dialog>
  )
}
