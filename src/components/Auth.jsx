import { useState } from 'react'
import { signUp, signIn, resetPasswordForEmail, verifyRecoveryOtp } from '../api/supabase.js'
import Icon from './Icon.jsx'

export default function Auth({ onRecoveryVerified }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [msg, setMsg] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setMsg(null)
    setSubmitting(true)
    try {
      if (mode === 'signup') {
        await signUp(email, password, fullName)
        setMsg({ kind: 'ok', text: 'สมัครสำเร็จ! กรุณายืนยัน Email ที่ส่งให้คุณ' })
      } else if (mode === 'forgot') {
        await resetPasswordForEmail(email)
        setMode('otp')
        setMsg({ kind: 'ok', text: 'ส่งรหัสยืนยันไปที่อีเมลแล้ว กรอกรหัสด้านล่างเพื่อตั้งรหัสผ่านใหม่' })
      } else if (mode === 'otp') {
        await verifyRecoveryOtp(email, otpCode)
        onRecoveryVerified()
      } else {
        await signIn(email, password)
      }
    } catch (err) {
      setMsg({ kind: 'err', text: err.message || 'เกิดข้อผิดพลาด' })
    } finally {
      setSubmitting(false)
    }
  }

  const backToSignin = () => {
    setMode('signin')
    setOtpCode('')
    setMsg(null)
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
            <h1 style={{ fontSize: 22, margin: 0 }}>TCM Document Agent</h1>
            <div className="muted small">v5 · Engineering Edition</div>
          </div>
        </div>

        {mode === 'signin' || mode === 'signup' ? (
          <div className="auth-tabs">
            <button
              className={mode === 'signin' ? 'tab on' : 'tab'}
              onClick={() => {
                setMode('signin')
                setMsg(null)
              }}
              type="button"
            >
              เข้าสู่ระบบ
            </button>
            <button
              className={mode === 'signup' ? 'tab on' : 'tab'}
              onClick={() => {
                setMode('signup')
                setMsg(null)
              }}
              type="button"
            >
              สมัครสมาชิก
            </button>
          </div>
        ) : null}

        <form onSubmit={handleSubmit}>
          {mode === 'signup' && (
            <div className="field">
              <label>ชื่อ-นามสกุล</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="ชื่อของคุณ"
                required
              />
            </div>
          )}

          {mode !== 'otp' && (
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your-email@teamcm.co.th"
                required
              />
            </div>
          )}

          {(mode === 'signin' || mode === 'signup') && (
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="อย่างน้อย 6 ตัว"
                minLength={6}
                required
              />
            </div>
          )}

          {mode === 'otp' && (
            <div className="field">
              <label>รหัสยืนยันจากอีเมล ({email})</label>
              <input
                type="text"
                inputMode="numeric"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="กรอกรหัสตัวเลขจากอีเมล"
                required
                autoFocus
              />
            </div>
          )}

          {mode === 'signin' && (
            <button
              type="button"
              className="link-btn"
              style={{ background: 'none', border: 'none', padding: 0, marginTop: -8, marginBottom: 4, fontSize: 12.5, color: 'var(--navy)', cursor: 'pointer', alignSelf: 'flex-end' }}
              onClick={() => {
                setMode('forgot')
                setMsg(null)
              }}
            >
              ลืมรหัสผ่าน?
            </button>
          )}

          {msg && <div className={`auth-msg ${msg.kind}`}>{msg.text}</div>}

          <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={submitting}>
            <Icon name={mode === 'forgot' || mode === 'otp' ? 'send' : mode === 'signin' ? 'arrow-r' : 'check'} size={15} />
            {submitting
              ? 'กำลังโหลด...'
              : mode === 'forgot'
                ? 'ส่งรหัสยืนยัน'
                : mode === 'otp'
                  ? 'ยืนยันรหัส'
                  : mode === 'signin'
                    ? 'เข้าสู่ระบบ'
                    : 'สมัครสมาชิก'}
          </button>

          {(mode === 'forgot' || mode === 'otp') && (
            <button
              type="button"
              className="link-btn"
              style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, fontSize: 12.5, color: 'var(--gray-400)', cursor: 'pointer' }}
              onClick={backToSignin}
            >
              ← กลับไปเข้าสู่ระบบ
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
