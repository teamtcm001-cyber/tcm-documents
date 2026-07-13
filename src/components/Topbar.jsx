import Icon from './Icon.jsx'

export default function Topbar({ user, active, onNav, onOpenUpload, onOpenChat, onOpenMOM, onChangeName }) {
  const initials = (() => {
    const n = user?.user_metadata?.full_name || user?.email || '?'
    return n.slice(0, 2).toUpperCase()
  })()
  const displayName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || ''

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
        <nav className="nav">
          <button className={active === 'dashboard' ? 'active' : ''} onClick={() => onNav('dashboard')}>
            <Icon name="layers" size={15} /> ภาพรวม
          </button>
          <button className={active === 'projects' ? 'active' : ''} onClick={() => onNav('projects')}>
            <Icon name="folder" size={15} /> โครงการ
          </button>
          <button className={active === 'ai' ? 'active' : ''} onClick={onOpenChat}>
            <Icon name="sparkles" size={15} /> ถามหาเอกสาร
          </button>
        </nav>
        <button className="btn btn-sm" style={{ background: 'var(--gray-100)', color: 'var(--navy)' }} title="แจ้งเตือน">
          <Icon name="bell" size={15} />
        </button>
        <button className="mom-fab-btn" onClick={onOpenMOM}>
          <Icon name="doc-text" size={15} /> เขียน MOM
        </button>
        <button className="btn btn-sm btn-navy" onClick={onOpenUpload}>
          <Icon name="upload" size={15} /> อัปโหลด
        </button>
        <button
          className="user-pill"
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          title="แก้ไขชื่อ/รหัสพนักงาน"
          onClick={onChangeName}
        >
          <div className="avatar">{initials}</div>
          <span className="uname">{displayName}</span>
        </button>
      </div>
    </header>
  )
}
