import { useState } from 'react'
import { updatePassword, signOut } from '../api/supabase.js'
import Icon from './Icon.jsx'

export default function ResetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setMsg(null)
    if (password !== confirm) {
      setMsg({ kind: 'err', text: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' })
      return
    }
    setSubmitting(true)
    try {
      await updatePassword(password)
      setMsg({ kind: 'ok', text: 'ตั้งรหัสผ่านใหม่สำเร็จ! กรุณาเข้าสู่ระบบอีกครั้ง' })
      await signOut()
      setTimeout(() => onDone(), 1500)
    } catch (err) {
      setMsg({ kind: 'err', text: err.message || 'เกิดข้อผิดพลาด' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 48, height: 48, fontSize: 20 }}>
            T
          </div>
          <div>
            <h1 style={{ fontSize: 22, margin: 0 }}>ตั้งรหัสผ่านใหม่</h1>
            <div className="muted small">TCM Document Agent</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>รหัสผ่านใหม่</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="อย่างน้อย 6 ตัว"
              minLength={6}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label>ยืนยันรหัสผ่านใหม่</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="พิมพ์รหัสผ่านอีกครั้ง"
              minLength={6}
              required
            />
          </div>

          {msg && <div className={`auth-msg ${msg.kind}`}>{msg.text}</div>}

          <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={submitting}>
            <Icon name="check" size={15} />
            {submitting ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่านใหม่'}
          </button>
        </form>
      </div>
    </div>
  )
}
