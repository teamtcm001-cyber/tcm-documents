import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { RoleBadge, ReadOnlyBadge } from './AccessBits.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { ROLE_DESC } from '../utils/roles.js'

function AccountMenu({ onChangePassword }) {
  const { profile, role, isExec, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)

  const name = profile?.full_name || profile?.email?.split('@')[0] || ''
  const initials = (name || '?').slice(0, 2).toUpperCase()

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // focus the first item so the menu is usable from the keyboard
    wrapRef.current?.querySelector('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onMenuKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(wrapRef.current.querySelectorAll('[role="menuitem"]'))
    const i = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const act = (fn) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="acct" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-pill user-pill-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`บัญชีของฉัน: ${name}`}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-menu-button"
      >
        <div className="avatar">{initials}</div>
        <span className="uname">{name}</span>
        <RoleBadge role={role} />
      </button>
      {open && (
        <div className="acct-menu" role="menu" aria-label="บัญชีของฉัน" onKeyDown={onMenuKeyDown}>
          <div className="acct-head">
            <div className="acct-name">{name}</div>
            <div className="muted small acct-email">{profile?.email}</div>
            <div className="acct-role">
              <RoleBadge role={role} />
              {isExec && <ReadOnlyBadge />}
            </div>
            <div className="muted small">{ROLE_DESC[role]}</div>
          </div>
          <button type="button" role="menuitem" className="acct-item" onClick={act(onChangePassword)}>
            <Icon name="key" size={15} /> เปลี่ยนรหัสผ่าน
          </button>
          <button type="button" role="menuitem" className="acct-item" onClick={act(logout)}>
            <Icon name="logout" size={15} /> ออกจากระบบ
          </button>
        </div>
      )}
    </div>
  )
}

export default function Topbar({ active, onNav, onOpenUpload, onOpenChat, onChangePassword }) {
  const { isAdmin, canUploadAny } = useAuth()

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <div className="brand-mark">T</div>
          <div className="brand-text">
            <span className="name">TCM Document Agent</span>
            <span className="sub">v5 · Engineering Edition</span>
          </div>
        </div>
        <nav className="nav" aria-label="เมนูหลัก">
          <button className={active === 'dashboard' ? 'active' : ''} onClick={() => onNav('dashboard')}>
            <Icon name="layers" size={15} /> ภาพรวม
          </button>
          <button className={active === 'projects' ? 'active' : ''} onClick={() => onNav('projects')}>
            <Icon name="folder" size={15} /> โครงการ
          </button>
          <button className={active === 'tracking' ? 'active' : ''} onClick={() => onNav('tracking')}>
            <Icon name="trend-up" size={15} /> ติดตามงาน
          </button>
          <button className={active === 'ai' ? 'active' : ''} onClick={onOpenChat}>
            <Icon name="sparkles" size={15} /> ถามหาเอกสาร
          </button>
          {isAdmin && (
            <button
              className={active === 'admin' ? 'active' : ''}
              onClick={() => onNav('admin')}
              aria-current={active === 'admin' ? 'page' : undefined}
              data-testid="nav-admin"
            >
              <Icon name="users" size={15} /> ผู้ใช้และสิทธิ์
            </button>
          )}
        </nav>
        <button className="btn btn-sm topbar-bell" style={{ background: 'var(--gray-100)', color: 'var(--navy)' }} title="แจ้งเตือน" aria-label="แจ้งเตือน">
          <Icon name="bell" size={15} />
        </button>
        {canUploadAny && (
          <button className="btn btn-sm btn-navy" onClick={onOpenUpload}>
            <Icon name="upload" size={15} /> อัปโหลด
          </button>
        )}
        <AccountMenu onChangePassword={onChangePassword} />
      </div>
    </header>
  )
}
