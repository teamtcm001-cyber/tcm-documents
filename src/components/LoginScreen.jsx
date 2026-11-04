import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { useAuth } from '../auth/AuthContext.jsx'

export function AuthBrand({ subtitle = 'v5 · Engineering Edition' }) {
  return (
    <div className="auth-brand">
      <div className="brand-mark" style={{ width: 48, height: 48, fontSize: 20 }}>
        T
      </div>
      <div>
        <h1 style={{ fontSize: 22, margin: 0 }}>TCM Document Agent</h1>
        <div className="muted small">{subtitle}</div>
      </div>
    </div>
  )
}

// Password input with a show/hide toggle. `autoComplete` must be current-password / new-password.
export function PasswordField({ id, label, value, onChange, autoComplete, describedBy, invalid, autoFocus, inputRef, disabled }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-wrap">
        <input
          id={id}
          ref={inputRef}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          aria-invalid={invalid ? 'true' : undefined}
          autoFocus={autoFocus}
          disabled={disabled}
          required
        />
        <button
          type="button"
          className="pw-toggle"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
          aria-pressed={shown}
          title={shown ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
        >
          <Icon name={shown ? 'eye-off' : 'eye'} size={16} />
        </button>
      </div>
    </div>
  )
}

export default function LoginScreen() {
  const { login, notice } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const emailRef = useRef(null)
  const passRef = useRef(null)
  const refocusPassword = useRef(false)

  useEffect(() => {
    emailRef.current?.focus()
  }, [])

  // the inputs are disabled while a sign-in is running: move focus once they are enabled again
  useEffect(() => {
    if (!busy && refocusPassword.current) {
      refocusPassword.current = false
      passRef.current?.focus()
    }
  }, [busy])

  const onSubmit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (!email.trim() || !password) {
      setError('กรุณากรอกอีเมลและรหัสผ่าน')
      return
    }
    setBusy(true)
    setError('')
    try {
      await login(email, password)
    } catch (err) {
      setError(err?.message || 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setPassword('')
      setBusy(false)
      // wrong password: put the cursor back where the fix is
      refocusPassword.current = err?.code === 'invalid_credentials'
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <main className="auth-card" aria-labelledby="login-title">
        <AuthBrand />
        <h2 id="login-title" className="auth-title">
          เข้าสู่ระบบ
        </h2>

        {notice === 'expired' && !error && (
          <div className="auth-msg ok" role="status" data-testid="session-expired">
            เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="login-email">อีเมล</label>
            <input
              id="login-email"
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? 'login-error' : undefined}
              placeholder="name@company.co.th"
              disabled={busy}
              required
            />
          </div>
          <PasswordField
            id="login-password"
            inputRef={passRef}
            label="รหัสผ่าน"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            describedBy={error ? 'login-error' : undefined}
            invalid={!!error}
            disabled={busy}
          />

          {error && (
            <div className="auth-msg err" role="alert" id="login-error">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            <Icon name="lock" size={15} />
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>

        <p className="muted small auth-help">
          ลืมรหัสผ่านหรือยังไม่มีบัญชี? ติดต่อผู้ดูแลระบบ (แอดมิน) เพื่อรีเซ็ตรหัสผ่านหรือขอสร้างบัญชีให้
        </p>
      </main>
    </div>
  )
}
