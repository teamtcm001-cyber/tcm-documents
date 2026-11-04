import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Dialog, { ConfirmDialog } from './ui/Dialog.jsx'
import { ToneBadge } from './TrackingBits.jsx'
import { RoleBadge } from './AccessBits.jsx'
import { useToast } from './Toast.jsx'
import {
  fetchMemberships, setMembership, adminSetRole, adminSetActive, adminResetPassword, adminUpdateProfile,
} from '../api/supabase.js'
import { ROLES, ROLE_LABEL, ROLE_DESC, MEMBERSHIP_LABEL } from '../utils/roles.js'
import { fmtThaiDateTime } from '../utils/tracking.js'

// What a role change means, shown in the confirmation.
const ROLE_CONSEQUENCE = {
  admin: 'จะจัดการผู้ใช้และสิทธิ์ สร้าง/ลบโครงการ และเห็น-แก้ไขได้ทุกโครงการ',
  exec: 'จะเห็นทุกโครงการ แต่อ่านอย่างเดียว (แก้ไข/อัปโหลดไม่ได้) สิทธิ์รายโครงการที่เคยกำหนดจะไม่มีผล',
  user: 'จะเห็นเฉพาะโครงการที่ได้รับสิทธิ์ (แก้ไขได้หรือดูอย่างเดียวรายโครงการ) และไม่สามารถจัดการผู้ใช้ได้',
}

// Small notes for the admin when the server finished the action but a side effect did not:
//   sessionsRevoked:false  the person's devices were not signed out
//   authBanned:false       the sign-in ban could not be set at the auth provider
//   audit:false            the audit-log entry could not be written
export function serverNotes(res) {
  const notes = []
  if (res?.sessionsRevoked === false) notes.push('ระบบยังไม่ได้ออกจากระบบอุปกรณ์เดิมของผู้ใช้ — เซสชันเดิมอาจใช้งานได้จนหมดอายุ')
  if (res?.authBanned === false) notes.push('ระบบยังไม่ได้ล็อกการเข้าสู่ระบบของบัญชีนี้ที่ฝั่งผู้ให้บริการ (การเข้าถึงข้อมูลถูกปิดแล้ว)')
  if (res?.audit === false) notes.push('บันทึกประวัติการเปลี่ยนแปลง (audit) ไม่สำเร็จ — โปรดแจ้งผู้ดูแลฐานข้อมูล')
  return notes
}

// Per-project access of one user. Writes project_members straight away (one row per project/user;
// "ไม่มีสิทธิ์" deletes the row). Admin / exec see every project by role, so the matrix is disabled.
function AccessMatrix({ user, projects, onCountChange }) {
  const toast = useToast()
  const byRole = user.role === 'admin' ? 'editor' : user.role === 'exec' ? 'viewer' : null
  const [map, setMap] = useState(null) // { [project_id]: 'editor'|'viewer' }
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState({}) // project_id -> true
  const savingRef = useRef({}) // synchronous guard: two quick changes send one request
  const [rowErr, setRowErr] = useState({}) // project_id -> message
  const [search, setSearch] = useState('')

  const load = async () => {
    setMap(null)
    setLoadError('')
    try {
      const rows = await fetchMemberships(user.id)
      const m = {}
      for (const r of rows) m[r.project_id] = r.role
      setMap(m)
    } catch (err) {
      setLoadError(err?.message || 'โหลดสิทธิ์ไม่สำเร็จ')
    }
  }
  useEffect(() => {
    if (!byRole) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, byRole])

  const valueOf = (pid) => (byRole ? byRole : map?.[pid] || 'none')

  const change = async (project, next) => {
    const pid = project.id
    const prev = map?.[pid] || 'none'
    if (prev === next || savingRef.current[pid]) return
    savingRef.current[pid] = true
    setSaving((s) => ({ ...s, [pid]: true }))
    setRowErr((e) => ({ ...e, [pid]: '' }))
    // optimistic
    setMap((m) => {
      const n = { ...m }
      if (next === 'none') delete n[pid]
      else n[pid] = next
      return n
    })
    try {
      await setMembership(pid, user.id, next === 'none' ? null : next)
      onCountChange?.(prev === 'none' ? +1 : next === 'none' ? -1 : 0)
    } catch (err) {
      setMap((m) => {
        const n = { ...m }
        if (prev === 'none') delete n[pid]
        else n[pid] = prev
        return n
      })
      setRowErr((e) => ({ ...e, [pid]: err?.message || 'บันทึกสิทธิ์ไม่สำเร็จ' }))
      toast(`บันทึกสิทธิ์โครงการ ${project.code || project.name} ไม่สำเร็จ`, 'err')
    } finally {
      savingRef.current[pid] = false
      setSaving((s) => ({ ...s, [pid]: false }))
    }
  }

  const shown = useMemo(() => {
    const t = search.trim().toLowerCase()
    return projects.filter((p) => !t || `${p.code || ''} ${p.name || ''}`.toLowerCase().includes(t))
  }, [projects, search])

  const counts = useMemo(() => {
    const c = { editor: 0, viewer: 0, none: 0 }
    for (const p of projects) c[map?.[p.id] || 'none'] += 1
    return c
  }, [map, projects])

  return (
    <section className="adm-section" aria-labelledby="adm-matrix-h">
      <h4 id="adm-matrix-h">สิทธิ์รายโครงการ</h4>

      {user.role === 'admin' && (
        <div className="adm-note" data-testid="matrix-note-admin">
          <Icon name="shield" size={14} /> <span>เห็นและแก้ไขทุกโครงการ (ตามบทบาทแอดมิน) — ไม่ต้องกำหนดรายโครงการ</span>
        </div>
      )}
      {user.role === 'exec' && (
        <div className="adm-note" data-testid="matrix-note-exec">
          <Icon name="eye" size={14} /> <span>เห็นทุกโครงการ (อ่านอย่างเดียว) — ไม่ต้องกำหนดรายโครงการ</span>
        </div>
      )}
      {user.role === 'user' && !user.active && (
        <div className="adm-note warn">
          <Icon name="alert" size={14} /> <span>บัญชีนี้ปิดการใช้งานอยู่ สิทธิ์ที่กำหนดจะมีผลเมื่อเปิดใช้งานอีกครั้ง</span>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="muted small" style={{ padding: '10px 0' }}>ยังไม่มีโครงการในระบบ</div>
      ) : loadError ? (
        <div className="auth-msg err" role="alert">
          {loadError}{' '}
          <button type="button" className="trk-link-btn" onClick={load}>
            ลองอีกครั้ง
          </button>
        </div>
      ) : !byRole && map === null ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 20 }}>
          <div className="spinner" style={{ width: 24, height: 24 }} />
        </div>
      ) : (
        <>
          {!byRole && (
            <div className="adm-matrix-sum small muted" aria-live="polite">
              แก้ไขได้ {counts.editor} · ดูอย่างเดียว {counts.viewer} · ไม่มีสิทธิ์ {counts.none} (จากทั้งหมด {projects.length} โครงการ)
            </div>
          )}
          {projects.length > 6 && (
            <div className="field" style={{ margin: '8px 0' }}>
              <label htmlFor="adm-matrix-q" className="sr-only">ค้นหาโครงการ</label>
              <input id="adm-matrix-q" type="search" placeholder="ค้นหาโครงการ (รหัส / ชื่อ)" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
          <ul className="adm-matrix" data-testid="access-matrix">
            {shown.map((p) => (
              <li key={p.id} className="adm-matrix-row">
                <div className="adm-matrix-proj">
                  <span className="adm-dot" style={{ background: p.color || '#3A6EA5' }} aria-hidden="true" />
                  <div style={{ minWidth: 0 }}>
                    <div className="adm-matrix-name">{p.name}</div>
                    <div className="muted small">{p.code}</div>
                  </div>
                </div>
                <div className="adm-matrix-ctl">
                  <select
                    aria-label={`สิทธิ์ในโครงการ ${p.code || ''} ${p.name}`}
                    value={valueOf(p.id)}
                    disabled={!!byRole || saving[p.id]}
                    onChange={(e) => change(p, e.target.value)}
                    data-project={p.id}
                  >
                    <option value="none">{MEMBERSHIP_LABEL.none}</option>
                    <option value="viewer">{MEMBERSHIP_LABEL.viewer}</option>
                    <option value="editor">{MEMBERSHIP_LABEL.editor}</option>
                  </select>
                  {saving[p.id] && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-label="กำลังบันทึก" />}
                </div>
                {rowErr[p.id] && (
                  <div className="adm-row-err small" role="alert">
                    {rowErr[p.id]}
                  </div>
                )}
              </li>
            ))}
            {shown.length === 0 && <li className="muted small" style={{ padding: 10 }}>ไม่พบโครงการที่ค้นหา</li>}
          </ul>
        </>
      )}
    </section>
  )
}

// Manage one account: name, role, active, password reset, project access.
export default function AdminUserDialog({ user, projects, isSelf, onClose, onUserChanged, onSecret, onCountChange }) {
  const toast = useToast()
  const [name, setName] = useState(user.full_name || '')
  const [nameBusy, setNameBusy] = useState(false)
  const [role, setRole] = useState(user.role)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(null) // 'role' | 'deactivate' | 'reset'
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const [notes, setNotes] = useState([])
  const busyRef = useRef(false) // synchronous guard: two clicks in the same tick send ONE request
  const nameBusyRef = useRef(false)

  useEffect(() => setRole(user.role), [user.role])
  useEffect(() => setName(user.full_name || ''), [user.full_name])

  const display = user.full_name || user.email

  const saveName = async (e) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || n === (user.full_name || '') || nameBusyRef.current) return
    nameBusyRef.current = true
    setNameBusy(true)
    setError('')
    try {
      const res = await adminUpdateProfile(user.id, n)
      onUserChanged(res.user)
      toast('บันทึกชื่อเรียบร้อย')
      setNotes(serverNotes(res))
    } catch (err) {
      setError(err?.message || 'บันทึกชื่อไม่สำเร็จ')
    } finally {
      nameBusyRef.current = false
      setNameBusy(false)
    }
  }

  const closeConfirm = () => {
    setConfirm(null)
    setConfirmError('')
  }

  // Runs a confirmed action; the confirmation stays open (with the server's Thai message) if it fails.
  // An action started from a button with no confirmation open (e.g. "เปิดการใช้งานบัญชี") reports on the page instead.
  const run = async (fn, okMsg) => {
    if (busyRef.current || busy) return
    busyRef.current = true
    setBusy(true)
    setConfirmError('')
    setError('')
    setNotes([])
    try {
      const res = await fn()
      if (okMsg) toast(okMsg)
      closeConfirm()
      setNotes(serverNotes(res))
    } catch (err) {
      const msg = err?.message || 'ดำเนินการไม่สำเร็จ'
      if (confirm) setConfirmError(msg)
      else setError(msg)
      if (confirm === 'role') setRole(user.role)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const doRole = () =>
    run(async () => {
      const res = await adminSetRole(user.id, role)
      onUserChanged(res.user)
      return res
    }, `เปลี่ยนบทบาทของ ${display} เป็น ${ROLE_LABEL[role]} แล้ว`)

  const doActive = (active) =>
    run(async () => {
      const res = await adminSetActive(user.id, active)
      onUserChanged(res.user)
      return res
    }, active ? `เปิดใช้งานบัญชี ${display} แล้ว` : `ปิดการใช้งานบัญชี ${display} แล้ว`)

  const doReset = () =>
    run(async () => {
      const res = await adminResetPassword(user.id)
      onUserChanged(res.user)
      onSecret({
        kind: 'reset',
        email: user.email,
        name: user.full_name,
        password: res.temporaryPassword,
        sessionsRevoked: res.sessionsRevoked,
        audit: res.audit,
      })
      return res
    })

  const selfHint = 'ไม่สามารถทำกับบัญชีของตัวเองได้ (ป้องกันการล็อกตัวเองออกจากระบบ)'

  return (
    <Dialog title={`จัดการผู้ใช้: ${display}`} onClose={onClose} size="lg" initialFocus="#adm-name">
      <div className="modal-body adm-manage" data-testid="user-dialog">
        <div className="adm-user-head">
          <div className="muted">{user.email}</div>
          <div className="adm-badges">
            <RoleBadge role={user.role} />
            <ToneBadge tone={user.active ? 'ok' : 'bad'}>{user.active ? 'ใช้งานอยู่' : 'ปิดการใช้งาน'}</ToneBadge>
            {user.must_change_password && <ToneBadge tone="warn">ต้องตั้งรหัสผ่านใหม่</ToneBadge>}
            {isSelf && <ToneBadge tone="info">บัญชีของคุณ</ToneBadge>}
          </div>
          <div className="muted small">เข้าใช้งานล่าสุด: {user.last_sign_in_at ? fmtThaiDateTime(user.last_sign_in_at) : 'ยังไม่เคยเข้าใช้งาน'}</div>
        </div>

        {error && (
          <div className="auth-msg err" role="alert">
            {error}
          </div>
        )}
        {notes.length > 0 && (
          <div className="adm-note warn" role="status" data-testid="server-notes">
            <Icon name="alert" size={14} />
            <span>
              {notes.map((n, i) => (
                <span key={i} style={{ display: 'block' }}>{n}</span>
              ))}
            </span>
          </div>
        )}

        <section className="adm-section" aria-labelledby="adm-prof-h">
          <h4 id="adm-prof-h">ชื่อที่แสดง</h4>
          <form className="adm-inline" onSubmit={saveName}>
            <div className="field" style={{ margin: 0, flex: 1 }}>
              <label htmlFor="adm-name" className="sr-only">ชื่อ-นามสกุล</label>
              <input id="adm-name" value={name} onChange={(e) => setName(e.target.value)} disabled={nameBusy} maxLength={120} />
            </div>
            <button type="submit" className="btn btn-ghost btn-sm" disabled={nameBusy || !name.trim() || name.trim() === (user.full_name || '')}>
              {nameBusy ? 'กำลังบันทึก...' : 'บันทึกชื่อ'}
            </button>
          </form>
        </section>

        <section className="adm-section" aria-labelledby="adm-role-h">
          <h4 id="adm-role-h">บทบาท</h4>
          <div className="adm-inline">
            <div className="field" style={{ margin: 0, flex: 1 }}>
              <label htmlFor="adm-role" className="sr-only">บทบาท</label>
              <select id="adm-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf} aria-describedby="adm-role-desc">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={isSelf || role === user.role}
              onClick={() => setConfirm('role')}
              data-testid="role-save"
            >
              บันทึกบทบาท
            </button>
          </div>
          <div className="muted small" id="adm-role-desc">
            {isSelf ? selfHint : ROLE_DESC[role]}
          </div>
        </section>

        <section className="adm-section" aria-labelledby="adm-sec-h">
          <h4 id="adm-sec-h">ความปลอดภัยของบัญชี</h4>
          <div className="adm-actions">
            {user.active ? (
              <button type="button" className="btn btn-ghost btn-sm adm-danger" disabled={isSelf} onClick={() => setConfirm('deactivate')} data-testid="deactivate">
                <Icon name="lock" size={14} /> ปิดการใช้งานบัญชี
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => doActive(true)} disabled={busy} data-testid="activate">
                <Icon name="check" size={14} /> เปิดการใช้งานบัญชี
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={isSelf} onClick={() => setConfirm('reset')} data-testid="reset-password">
              <Icon name="key" size={14} /> รีเซ็ตรหัสผ่าน
            </button>
          </div>
          {isSelf && <div className="muted small">{selfHint}</div>}
        </section>

        <AccessMatrix user={user} projects={projects} onCountChange={onCountChange} />
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          เสร็จสิ้น
        </button>
      </div>

      {confirm === 'role' && (
        <ConfirmDialog
          title={`เปลี่ยนบทบาทของ ${display}?`}
          confirmLabel="ยืนยันเปลี่ยนบทบาท"
          danger={role === 'admin' || user.role === 'admin'}
          busy={busy}
          error={confirmError}
          onConfirm={doRole}
          onCancel={() => {
            closeConfirm()
            setRole(user.role)
          }}
        >
          <p style={{ marginTop: 0 }}>
            จาก <b>{ROLE_LABEL[user.role]}</b> เป็น <b>{ROLE_LABEL[role]}</b>
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>{ROLE_CONSEQUENCE[role]}</p>
        </ConfirmDialog>
      )}
      {confirm === 'deactivate' && (
        <ConfirmDialog
          title={`ปิดการใช้งานบัญชีของ ${display}?`}
          confirmLabel="ปิดการใช้งาน"
          danger
          busy={busy}
          error={confirmError}
          onConfirm={() => doActive(false)}
          onCancel={closeConfirm}
        >
          <p style={{ marginTop: 0 }}>ผู้ใช้นี้จะเข้าสู่ระบบและใช้งานข้อมูลไม่ได้ทันที</p>
          <p className="muted" style={{ marginBottom: 0 }}>ข้อมูลบัญชีและสิทธิ์โครงการยังอยู่ เปิดใช้งานกลับมาได้ภายหลัง</p>
        </ConfirmDialog>
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title={`รีเซ็ตรหัสผ่านของ ${display}?`}
          confirmLabel="รีเซ็ตรหัสผ่าน"
          danger
          busy={busy}
          error={confirmError}
          onConfirm={doReset}
          onCancel={closeConfirm}
        >
          <p style={{ marginTop: 0 }}>รหัสผ่านเดิมจะใช้ไม่ได้ทันที</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            ระบบจะสร้างรหัสผ่านชั่วคราวใหม่ให้ (แสดงครั้งเดียว) และผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบ
          </p>
        </ConfirmDialog>
      )}
    </Dialog>
  )
}
