import Icon from './Icon.jsx'
import { ToneBadge } from './TrackingBits.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import {
  ROLE_LABEL, ROLE_TONE, READ_ONLY_LABEL, NO_PROJECT_ACCESS_MESSAGE, MEMBERSHIP_LABEL, MEMBER_ROLE_TONE, MEMBER_ROLE_DESC,
} from '../utils/roles.js'

export function RoleBadge({ role }) {
  if (!role) return null
  return <ToneBadge tone={ROLE_TONE[role] || 'mute'}>{ROLE_LABEL[role] || role}</ToneBadge>
}

// project_members.role of one person in one project (ผู้ดูแลโครงการ / แก้ไขได้ / ดูอย่างเดียว)
export function MemberRoleBadge({ role }) {
  if (!role) return null
  return (
    <ToneBadge tone={MEMBER_ROLE_TONE[role] || 'mute'} title={MEMBER_ROLE_DESC[role]}>
      {MEMBERSHIP_LABEL[role] || role}
    </ToneBadge>
  )
}

// "You manage this project": shown to a project manager (admins manage everything, so they do not need it).
export function ManagerBadge({ className = '', style }) {
  return (
    <span
      className={`readonly-badge manager-badge ${className}`}
      title="คุณเป็นผู้ดูแลโครงการนี้ — แก้ไขโครงการและจัดการสมาชิกของโครงการได้"
      style={style}
      data-testid="manager-badge"
    >
      <Icon name="shield" size={12} /> {MEMBERSHIP_LABEL.manager}
    </span>
  )
}

// Subtle marker instead of silently hiding edit controls.
export function ReadOnlyBadge({ title = 'คุณมีสิทธิ์ดูข้อมูลเท่านั้น ไม่สามารถแก้ไขหรืออัปโหลดได้', className = '', style }) {
  return (
    <span className={`readonly-badge ${className}`} title={title} style={style} data-testid="readonly-badge">
      <Icon name="eye" size={12} /> {READ_ONLY_LABEL}
    </span>
  )
}

// Empty state for a signed-in person who can see no project.
// Exec/admin seeing nothing means the system itself is empty.
export function NoProjectsNotice({ onNewProject }) {
  const { isAdmin, isExec } = useAuth()
  const systemEmpty = isAdmin || isExec
  return (
    <div className="card empty-access" style={{ padding: 40, textAlign: 'center', color: 'var(--gray-500)' }} data-testid="no-projects">
      <Icon name={systemEmpty ? 'folder' : 'lock'} size={32} />
      <div style={{ marginTop: 8, color: systemEmpty ? undefined : 'var(--navy)', fontWeight: systemEmpty ? 400 : 500 }}>
        {systemEmpty ? 'ยังไม่มีโครงการในระบบ' : NO_PROJECT_ACCESS_MESSAGE}
      </div>
      {!systemEmpty && (
        <div className="small" style={{ marginTop: 6 }}>
          เมื่อผู้ดูแลระบบกำหนดสิทธิ์ให้แล้ว โครงการจะแสดงที่นี่ (ลองรีเฟรชหน้านี้)
        </div>
      )}
      {isAdmin && onNewProject && (
        <button className="btn btn-primary btn-sm" onClick={onNewProject} style={{ marginTop: 16 }}>
          <Icon name="plus" size={14} /> สร้างโครงการแรก
        </button>
      )}
    </div>
  )
}
