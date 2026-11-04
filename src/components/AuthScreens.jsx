import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { AuthBrand } from './LoginScreen.jsx'
import { useAuth } from '../auth/AuthContext.jsx'

export function LoadingScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }} role="status" aria-label="กำลังโหลด">
      <div className="spinner"></div>
    </div>
  )
}

// Blocking screen: the account exists but is deactivated (or has no profile).
export function DisabledScreen() {
  const { logout, profile, recheckAccount } = useAuth()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState('') // '' | 'disabled' | 'unavailable'
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const check = async () => {
    if (checking) return
    setChecking(true)
    setResult('')
    const r = await recheckAccount()
    if (!alive.current) return // the account is active again (or signed out): this screen is gone
    setChecking(false)
    if (r === 'disabled' || r === 'unavailable') setResult(r)
  }

  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <main className="auth-card" aria-labelledby="disabled-title" data-testid="account-disabled">
        <AuthBrand />
        <div className="auth-state-icon bad" aria-hidden="true">
          <Icon name="lock" size={26} />
        </div>
        <h2 id="disabled-title" className="auth-title" role="alert">
          บัญชีถูกปิดการใช้งาน
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          บัญชีนี้ไม่สามารถใช้งานระบบได้ในขณะนี้ หากคิดว่าเกิดจากความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ (แอดมิน)
        </p>
        {profile?.email && (
          <p className="small muted" style={{ marginTop: 0 }}>
            บัญชี: {profile.email}
          </p>
        )}
        {result && (
          <div className="auth-msg err" role="alert" data-testid="disabled-recheck-result">
            {result === 'disabled'
              ? 'ตรวจสอบแล้ว บัญชียังถูกปิดการใช้งานอยู่ — กรุณาติดต่อผู้ดูแลระบบ'
              : 'ตรวจสอบไม่สำเร็จ ระบบไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง'}
          </div>
        )}
        <button type="button" className="btn btn-primary auth-submit" onClick={check} disabled={checking} data-testid="disabled-recheck">
          <Icon name="refresh" size={15} /> {checking ? 'กำลังตรวจสอบ...' : 'ลองตรวจสอบอีกครั้ง'}
        </button>
        <button type="button" className="link-btn auth-link" onClick={logout}>
          <Icon name="logout" size={14} /> ออกจากระบบ
        </button>
      </main>
    </div>
  )
}

// Signed in, but the profile could not be read (network / server). Not the same as disabled.
export function ProfileErrorScreen() {
  const { retry, logout, loadError } = useAuth()
  return (
    <div className="auth-page">
      <div className="auth-bg-grid" />
      <main className="auth-card" aria-labelledby="perr-title">
        <AuthBrand />
        <h2 id="perr-title" className="auth-title">
          โหลดข้อมูลบัญชีไม่สำเร็จ
        </h2>
        <p className="muted" style={{ marginTop: 0 }} role="alert">
          {loadError || 'เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'}
        </p>
        <button type="button" className="btn btn-primary auth-submit" onClick={retry}>
          <Icon name="refresh" size={15} /> ลองอีกครั้ง
        </button>
        <button type="button" className="link-btn auth-link" onClick={logout}>
          ออกจากระบบ
        </button>
      </main>
    </div>
  )
}
