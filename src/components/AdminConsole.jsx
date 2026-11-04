import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from './Icon.jsx'
import { ToneBadge } from './TrackingBits.jsx'
import { RoleBadge } from './AccessBits.jsx'
import { CreateUserDialog, TempPasswordDialog } from './AdminCreateUser.jsx'
import AdminUserDialog from './AdminUserDialog.jsx'
import { useToast } from './Toast.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { adminListUsers, fetchAllProjectsForAdmin } from '../api/supabase.js'
import { ROLES, ROLE_LABEL } from '../utils/roles.js'
import { fmtThaiDateTime } from '../utils/tracking.js'

const ROLE_ORDER = { admin: 0, exec: 1, user: 2 }

function UserRow({ user, isSelf, onManage }) {
  const name = user.full_name || '(ยังไม่ระบุชื่อ)'
  const initials = (user.full_name || user.email || '?').slice(0, 2).toUpperCase()
  return (
    <li className={`adm-user ${user.active ? '' : 'inactive'}`} data-testid="user-row" data-email={user.email}>
      <div className="adm-user-main">
        <div className="avatar adm-avatar" aria-hidden="true">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div className="adm-user-name">
            {name} {isSelf && <ToneBadge tone="info">คุณ</ToneBadge>}
          </div>
          <div className="muted small adm-user-email">{user.email}</div>
        </div>
      </div>
      <div className="adm-user-badges">
        <RoleBadge role={user.role} />
        <ToneBadge tone={user.active ? 'ok' : 'bad'}>{user.active ? 'ใช้งานอยู่' : 'ปิดการใช้งาน'}</ToneBadge>
        {user.must_change_password && <ToneBadge tone="warn" title="ยังไม่ได้ตั้งรหัสผ่านใหม่หลังได้รับรหัสชั่วคราว">ต้องตั้งรหัสผ่านใหม่</ToneBadge>}
      </div>
      <div className="adm-user-proj small" data-testid="project-count">
        {user.role === 'user' ? (
          <>
            <b>{user.project_count ?? 0}</b> โครงการ
          </>
        ) : (
          <span className="muted">{user.role === 'exec' ? 'ทุกโครงการ (อ่านอย่างเดียว)' : 'ทุกโครงการ'}</span>
        )}
      </div>
      <div className="adm-user-last small muted">
        {user.last_sign_in_at ? fmtThaiDateTime(user.last_sign_in_at) : 'ยังไม่เคยเข้าใช้'}
      </div>
      <div className="adm-user-act">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onManage(user.id)} aria-label={`จัดการ ${user.full_name || user.email}`}>
          <Icon name="pen" size={13} /> จัดการ
        </button>
      </div>
    </li>
  )
}

// "ผู้ใช้และสิทธิ์" — admin only. The server (/api/admin-users + RLS) enforces everything; this is the UI.
export default function AdminConsole() {
  const { profile, isAdmin } = useAuth()
  const toast = useToast()
  const [users, setUsers] = useState(null)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [manageId, setManageId] = useState(null)
  const [secret, setSecret] = useState(null) // { kind, email, name, password, then? } — shown once, never persisted

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [list, projs] = await Promise.all([
        adminListUsers(),
        fetchAllProjectsForAdmin().catch((err) => {
          toast('โหลดรายการโครงการไม่สำเร็จ: ' + (err?.message || ''), 'err')
          return []
        }),
      ])
      setUsers(list)
      setProjects(projs)
    } catch (err) {
      setError(err?.message || 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  // merge the server's profile fields into the list (the list-only fields stay)
  const applyUser = (u) =>
    setUsers((list) => {
      if (!list) return list
      const i = list.findIndex((x) => x.id === u.id)
      if (i < 0) return [...list, { ...u, last_sign_in_at: null, project_count: 0 }]
      const next = [...list]
      next[i] = { ...next[i], ...u }
      return next
    })

  const bumpCount = (userId, delta) =>
    setUsers((list) => list?.map((u) => (u.id === userId ? { ...u, project_count: Math.max(0, (u.project_count || 0) + delta) } : u)))

  const stats = useMemo(() => {
    const l = users || []
    return {
      total: l.length,
      active: l.filter((u) => u.active).length,
      inactive: l.filter((u) => !u.active).length,
      pending: l.filter((u) => u.must_change_password).length,
    }
  }, [users])

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (users || [])
      .filter((u) => roleFilter === 'all' || u.role === roleFilter)
      .filter((u) => !t || `${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(t))
      .sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          (a.full_name || a.email || '').localeCompare(b.full_name || b.email || '', 'th')
      )
  }, [users, q, roleFilter])

  const managed = manageId ? (users || []).find((u) => u.id === manageId) : null

  if (!isAdmin) {
    return (
      <section className="section">
        <div className="container">
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>เฉพาะผู้ดูแลระบบเท่านั้น</div>
        </div>
      </section>
    )
  }

  return (
    <section className="section" aria-labelledby="adm-title">
      <div className="container">
        <div className="section-head">
          <div className="section-title">
            <h2 id="adm-title">ผู้ใช้และสิทธิ์</h2>
            <div className="sub">จัดการบัญชีผู้ใช้ บทบาท และสิทธิ์เข้าถึงรายโครงการ · การเปลี่ยนแปลงทั้งหมดถูกบันทึกในประวัติของระบบ</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
              <Icon name="refresh" size={14} /> รีเฟรช
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)} data-testid="add-user">
              <Icon name="plus" size={14} /> เพิ่มผู้ใช้
            </button>
          </div>
        </div>

        {error ? (
          <div className="card" style={{ padding: 28, textAlign: 'center' }} role="alert">
            <Icon name="alert" size={28} style={{ color: 'var(--red)' }} />
            <div style={{ marginTop: 8, color: 'var(--red)' }}>{error}</div>
            <button className="btn btn-ghost btn-sm" onClick={load} style={{ marginTop: 14 }}>
              <Icon name="refresh" size={14} /> ลองอีกครั้ง
            </button>
          </div>
        ) : loading && !users ? (
          <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            <div className="adm-stats" aria-live="polite">
              <div><b>{stats.total}</b><span>บัญชีทั้งหมด</span></div>
              <div><b>{stats.active}</b><span>ใช้งานอยู่</span></div>
              <div><b>{stats.inactive}</b><span>ปิดการใช้งาน</span></div>
              <div><b>{stats.pending}</b><span>รอตั้งรหัสผ่านใหม่</span></div>
            </div>

            <div className="trk-toolbar">
              <div className="field adm-search" style={{ margin: 0 }}>
                <label htmlFor="adm-q" className="sr-only">ค้นหาผู้ใช้</label>
                <input id="adm-q" type="search" placeholder="ค้นหาชื่อหรืออีเมล" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {['all', ...ROLES].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`filter-chip ${roleFilter === r ? 'on' : ''}`}
                  aria-pressed={roleFilter === r}
                  onClick={() => setRoleFilter(r)}
                >
                  {r === 'all' ? 'ทุกบทบาท' : ROLE_LABEL[r]}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--gray-500)' }}>
                {users?.length ? 'ไม่พบผู้ใช้ที่ตรงกับเงื่อนไข' : 'ยังไม่มีผู้ใช้'}
              </div>
            ) : (
              <div className="card adm-list-card">
                <div className="adm-list-head" aria-hidden="true">
                  <span>ผู้ใช้</span>
                  <span>บทบาท / สถานะ</span>
                  <span>โครงการ</span>
                  <span>เข้าใช้ล่าสุด</span>
                  <span />
                </div>
                <ul className="adm-list" data-testid="user-list">
                  {visible.map((u) => (
                    <UserRow key={u.id} user={u} isSelf={u.id === profile?.id} onManage={setManageId} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {createOpen && (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={({ user, temporaryPassword, sessionsRevoked, audit }) => {
            setCreateOpen(false)
            applyUser(user)
            setSecret({
              kind: 'create',
              email: user.email,
              name: user.full_name,
              password: temporaryPassword,
              sessionsRevoked,
              audit,
              // after the password is dealt with, go straight to project access for a member
              then: user.role === 'user' ? user.id : null,
            })
          }}
        />
      )}

      {managed && (
        <AdminUserDialog
          user={managed}
          projects={projects}
          isSelf={managed.id === profile?.id}
          onClose={() => setManageId(null)}
          onUserChanged={applyUser}
          onCountChange={(delta) => bumpCount(managed.id, delta)}
          onSecret={setSecret}
        />
      )}

      {secret && (
        <TempPasswordDialog
          secret={secret}
          onClose={() => {
            const next = secret.then
            setSecret(null) // the password is gone from memory/UI here
            if (next) setManageId(next)
          }}
        />
      )}
    </section>
  )
}
