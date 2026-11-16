import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { ConfirmDialog } from './ui/Dialog.jsx'
import { ToneBadge } from './TrackingBits.jsx'
import { MemberRoleBadge } from './AccessBits.jsx'
import { useToast } from './Toast.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { listProjectMembers, findUserForProject, setProjectMember, removeProjectMember, MEMBER_NOT_FOUND_MESSAGE } from '../api/supabase.js'
import { MEMBER_ROLES, MEMBER_ROLE_RANK, MEMBER_ROLE_DESC, MEMBERSHIP_LABEL } from '../utils/roles.js'

const byRoleThenName = (a, b) =>
  (MEMBER_ROLE_RANK[a.role] ?? 9) - (MEMBER_ROLE_RANK[b.role] ?? 9) ||
  (a.fullName || a.email).localeCompare(b.fullName || b.email, 'th')

const nameOf = (m) => m.fullName || m.email || 'ผู้ใช้'

// People of one project: list, change role, remove, add by exact e-mail. Only rendered for the project's
// managers and for admins (the database RPCs enforce the same; this is the UI half).
//  * only EXISTING, active accounts can be added (accounts are created by an Admin);
//  * a manager can appoint other managers but never changes / removes their own row (no controls on it);
//  * people are found by typing the FULL e-mail: the organisation's users are never listed, and a stranger's
//    e-mail appears only after an exact match.
export default function ProjectMembersPanel({ project }) {
  const { profile } = useAuth()
  const toast = useToast()
  const me = profile?.id || null
  const pid = project.id
  const pname = project.name || project.code || ''
  const uid = useId()

  const [members, setMembers] = useState(null) // null = loading
  const [loadError, setLoadError] = useState('')
  const [email, setEmail] = useState('')
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState(null) // { userId, email, fullName, memberRole }
  const [findMsg, setFindMsg] = useState(null) // { kind: 'none' | 'err', text }
  const [addRole, setAddRole] = useState('viewer')
  const [writing, setWriting] = useState(false)
  const [rowErr, setRowErr] = useState({}) // userId -> message
  const [formErr, setFormErr] = useState('')
  const [confirm, setConfirm] = useState(null) // { kind: 'manager' | 'remove', target, origin }
  const [confirmErr, setConfirmErr] = useState('')

  // synchronous guards: two clicks in the same tick send ONE request
  const writeRef = useRef(false)
  const findRef = useRef(false)
  const loadSeq = useRef(0) // only the LATEST load request may set state (quick consecutive writes start overlapping loads)
  const scope = useRef(0) // bumped when the project changes / the panel unmounts: late answers are dropped
  const emailRef = useRef(null)
  const roleRef = useRef(null)

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      const my = scope.current
      const req = ++loadSeq.current
      if (!quiet) setMembers(null)
      setLoadError('')
      try {
        const rows = await listProjectMembers(pid)
        if (my !== scope.current || req !== loadSeq.current) return
        setMembers(rows)
      } catch (err) {
        if (my !== scope.current || req !== loadSeq.current) return
        setLoadError(err?.message || 'โหลดรายชื่อสมาชิกไม่สำเร็จ')
        if (!quiet) setMembers((m) => m || [])
      }
    },
    [pid]
  )

  useEffect(() => {
    scope.current += 1
    setEmail('')
    setFound(null)
    setFindMsg(null)
    setFormErr('')
    setRowErr({})
    setConfirm(null)
    load()
    return () => {
      scope.current += 1
    }
  }, [load])

  const resetFind = () => {
    setFound(null)
    setFindMsg(null)
    setFormErr('')
  }

  const onFind = async (e) => {
    e?.preventDefault()
    if (findRef.current || writeRef.current) return
    findRef.current = true
    setFinding(true)
    resetFind()
    const my = scope.current
    try {
      const r = await findUserForProject(pid, email)
      if (my !== scope.current) return
      if (!r) {
        setFindMsg({ kind: 'none', text: MEMBER_NOT_FOUND_MESSAGE })
      } else {
        setFound(r)
        setAddRole(r.memberRole || 'viewer')
        setTimeout(() => roleRef.current?.focus(), 0)
      }
    } catch (err) {
      if (my !== scope.current) return
      setFindMsg({ kind: 'err', text: err?.message || 'ค้นหาไม่สำเร็จ กรุณาลองใหม่' })
    } finally {
      findRef.current = false
      setFinding(false)
    }
  }

  // add / change role. origin: 'row' (select in the list) | 'add' (the add form). viaConfirm: the manager dialog is open
  const doSet = async (target, role, { origin, viaConfirm = false }) => {
    if (writeRef.current) return
    writeRef.current = true
    setWriting(true)
    setRowErr((x) => ({ ...x, [target.userId]: '' }))
    setFormErr('')
    setConfirmErr('')
    const my = scope.current
    try {
      await setProjectMember(pid, target.userId, role)
      if (my !== scope.current) return
      const wasMember = (members || []).some((m) => m.userId === target.userId)
      toast(
        wasMember
          ? `เปลี่ยนสิทธิ์ของ ${nameOf(target)} เป็น "${MEMBERSHIP_LABEL[role]}" แล้ว`
          : `เพิ่ม ${nameOf(target)} เป็น "${MEMBERSHIP_LABEL[role]}" แล้ว`
      )
      setConfirm(null)
      // show the result at once, then re-read the truth. No refreshAccess() on success: the server refuses any change to
      // the signed-in person's OWN row, and a write that succeeded proves our rights were still valid. If another
      // manager / an admin changes this person's rights meanwhile, the next write answers FORBIDDEN, the data layer
      // reports 'denied' and AuthContext re-reads the memberships (see memberRpcError).
      setMembers((list) => {
        const l = list || []
        const next = l.some((m) => m.userId === target.userId)
          ? l.map((m) => (m.userId === target.userId ? { ...m, role } : m))
          : [...l, { userId: target.userId, email: target.email || '', fullName: target.fullName || '', role, active: true }]
        return next.sort(byRoleThenName)
      })
      if (origin === 'add') {
        setEmail('')
        resetFind()
        setTimeout(() => emailRef.current?.focus(), 0)
      }
      load({ quiet: true })
    } catch (err) {
      if (my !== scope.current) return
      const msg = err?.message || 'บันทึกสิทธิ์ไม่สำเร็จ'
      // our own rights changed: the app re-reads them and this panel may disappear, so say it where it stays visible
      if (err?.code === 'forbidden') toast(msg, 'err')
      if (viaConfirm) setConfirmErr(msg)
      else if (origin === 'add') setFormErr(msg)
      else setRowErr((x) => ({ ...x, [target.userId]: msg }))
    } finally {
      writeRef.current = false
      setWriting(false)
    }
  }

  const doRemove = async (target) => {
    if (writeRef.current) return
    writeRef.current = true
    setWriting(true)
    setConfirmErr('')
    const my = scope.current
    try {
      await removeProjectMember(pid, target.userId)
      if (my !== scope.current) return
      toast(`นำ ${nameOf(target)} ออกจากโครงการแล้ว`)
      setConfirm(null)
      setMembers((list) => (list || []).filter((m) => m.userId !== target.userId))
      // the opener (the removed row's button) is gone: put focus somewhere sensible
      setTimeout(() => emailRef.current?.focus(), 0)
      load({ quiet: true })
    } catch (err) {
      if (my !== scope.current) return
      if (err?.code === 'forbidden') toast(err.message, 'err')
      setConfirmErr(err?.message || 'นำออกไม่สำเร็จ')
    } finally {
      writeRef.current = false
      setWriting(false)
    }
  }

  const onRowRole = (m, next) => {
    if (!MEMBER_ROLES.includes(next) || next === m.role || writeRef.current) return
    if (next === 'manager') setConfirm({ kind: 'manager', target: m, origin: 'row' })
    else if (m.role === 'manager') setConfirm({ kind: 'demote', target: m, role: next, origin: 'row' })
    else doSet(m, next, { origin: 'row' })
  }

  const onAdd = () => {
    if (!found || writeRef.current) return
    const target = { userId: found.userId, email: found.email, fullName: found.fullName }
    if (addRole === 'manager' && foundRole !== 'manager') setConfirm({ kind: 'manager', target, origin: 'add' })
    else if (foundRole === 'manager' && addRole !== 'manager') setConfirm({ kind: 'demote', target, role: addRole, origin: 'add' })
    else doSet(target, addRole, { origin: 'add' })
  }

  const foundIsSelf = !!found && found.userId === me
  // the found card must not show a stale role: once the list is loaded it is the source of truth
  const foundRole = !found ? null : members ? members.find((m) => m.userId === found.userId)?.role ?? null : found.memberRole
  const emailId = `${uid}-email`
  useEffect(() => {
    // the person's role changed under the card (list change / another write): re-aim the select
    if (found) setAddRole(foundRole || 'viewer')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foundRole, found?.userId])
  const roleId = `${uid}-role`
  const descId = `${uid}-desc`

  return (
    <div className="pm" data-testid="members-panel">
      <section className="pm-add" aria-labelledby={`${uid}-add-h`}>
        <h3 id={`${uid}-add-h`} className="pm-h">เพิ่มคนเข้าโครงการ</h3>
        <p className="muted small pm-help">
          เพิ่มได้เฉพาะบัญชีที่มีอยู่แล้วในระบบ — พิมพ์อีเมลเต็มของผู้ที่ต้องการเพิ่ม (ถ้ายังไม่มีบัญชี ให้ติดต่อ Admin)
        </p>
        <form className="pm-find" onSubmit={onFind} noValidate>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 0 }}>
            <label htmlFor={emailId} className="sr-only">อีเมลของผู้ที่ต้องการเพิ่ม</label>
            <input
              id={emailId}
              ref={emailRef}
              type="text"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="อีเมลเต็ม เช่น name@company.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                resetFind()
              }}
              disabled={finding}
              data-testid="member-email"
            />
          </div>
          <button type="submit" className="btn btn-ghost btn-sm" disabled={finding || writing || !email.trim()} data-testid="member-find">
            <Icon name="search" size={13} /> {finding ? 'กำลังค้นหา...' : 'ค้นหา'}
          </button>
        </form>

        <div aria-live="polite" className="pm-result">
          {findMsg && (
            <div className="auth-msg err" role={findMsg.kind === 'err' ? 'alert' : 'status'} data-testid={findMsg.kind === 'none' ? 'member-not-found' : 'member-find-error'}>
              {findMsg.text}
            </div>
          )}
          {found && (
            <div className="pm-found" data-testid="found-user">
              <div className="pm-who">
                <div className="pm-name">{found.fullName || found.email}</div>
                <div className="muted small pm-email">{found.email}</div>
                {foundIsSelf ? (
                  <div className="small" style={{ marginTop: 4 }}>นี่คือบัญชีของคุณ — แก้ไขหรือลบสิทธิ์ของตัวเองไม่ได้</div>
                ) : foundRole ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    เป็นสมาชิกโครงการนี้อยู่แล้ว: <MemberRoleBadge role={foundRole} />
                  </div>
                ) : null}
              </div>
              {!foundIsSelf && (
                <div className="pm-found-ctl">
                  <label htmlFor={roleId} className="sr-only">สิทธิ์ที่จะให้ {found.fullName || found.email}</label>
                  <select
                    id={roleId}
                    ref={roleRef}
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value)}
                    disabled={writing}
                    aria-describedby={descId}
                    data-testid="add-role"
                  >
                    <option value="viewer">{MEMBERSHIP_LABEL.viewer}</option>
                    <option value="editor">{MEMBERSHIP_LABEL.editor}</option>
                    <option value="manager">{MEMBERSHIP_LABEL.manager}</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onAdd}
                    disabled={writing || (!!foundRole && foundRole === addRole)}
                    data-testid="member-add"
                  >
                    {foundRole ? 'บันทึกสิทธิ์' : 'เพิ่มเข้าโครงการ'}
                  </button>
                </div>
              )}
              {!foundIsSelf && <div className="muted small pm-found-desc" id={descId}>{MEMBER_ROLE_DESC[addRole]}</div>}
            </div>
          )}
          {formErr && (
            <div className="auth-msg err" role="alert" data-testid="member-form-error">{formErr}</div>
          )}
        </div>
      </section>

      <section className="pm-list-sec" aria-labelledby={`${uid}-list-h`}>
        <h3 id={`${uid}-list-h`} className="pm-h">
          สมาชิกโครงการ{members ? ` (${members.length} คน)` : ''}
        </h3>

        {loadError && (
          <div className="auth-msg err" role="alert" data-testid="members-load-error">
            {loadError}{' '}
            <button type="button" className="trk-link-btn" onClick={() => load()}>ลองอีกครั้ง</button>
          </div>
        )}

        {members === null ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 24 }} role="status" aria-label="กำลังโหลดรายชื่อสมาชิก">
            <div className="spinner" />
          </div>
        ) : members.length === 0 ? (
          !loadError && (
            <div className="muted pm-empty" data-testid="members-empty">
              ยังไม่มีสมาชิกในโครงการนี้ — เพิ่มคนได้จากช่องด้านบน
            </div>
          )
        ) : (
          <ul className="pm-list" data-testid="member-list">
            {members.map((m) => {
              const label = nameOf(m)
              const isMe = m.userId === me
              return (
                <li key={m.userId} className={`pm-row ${m.active ? '' : 'inactive'}`} data-testid="member-row" data-user={m.userId}>
                  <div className="pm-who">
                    <div className="pm-name">
                      <span>{label}</span>
                      {isMe && <ToneBadge tone="info">คุณ</ToneBadge>}
                      <MemberRoleBadge role={m.role} />
                      {!m.active && <ToneBadge tone="bad" title="บัญชีนี้ถูกปิดการใช้งานอยู่ จึงยังเข้าใช้ระบบไม่ได้">ปิดการใช้งาน</ToneBadge>}
                    </div>
                    {m.fullName && m.email && <div className="muted small pm-email">{m.email}</div>}
                  </div>
                  {!isMe && (
                    <div className="pm-ctl">
                      <select
                        aria-label={`สิทธิ์ของ ${label}`}
                        value={m.role}
                        onChange={(e) => onRowRole(m, e.target.value)}
                        disabled={writing}
                        data-testid="member-role"
                      >
                        <option value="manager">{MEMBERSHIP_LABEL.manager}</option>
                        <option value="editor">{MEMBERSHIP_LABEL.editor}</option>
                        <option value="viewer">{MEMBERSHIP_LABEL.viewer}</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm adm-danger"
                        aria-label={`นำ ${label} ออกจากโครงการ`}
                        onClick={() => setConfirm({ kind: 'remove', target: m })}
                        disabled={writing}
                        data-testid="member-remove"
                      >
                        <Icon name="trash" size={13} /> นำออก
                      </button>
                    </div>
                  )}
                  {rowErr[m.userId] && (
                    <div className="adm-row-err small" role="alert">{rowErr[m.userId]}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {confirm?.kind === 'manager' && (
        <ConfirmDialog
          title={`แต่งตั้ง ${nameOf(confirm.target)} เป็นผู้ดูแลโครงการ?`}
          confirmLabel="แต่งตั้งเป็นผู้ดูแลโครงการ"
          busy={writing}
          error={confirmErr}
          onConfirm={() => doSet(confirm.target, 'manager', { origin: confirm.origin, viaConfirm: true })}
          onCancel={() => {
            setConfirm(null)
            setConfirmErr('')
          }}
        >
          <p style={{ marginTop: 0 }}>
            <b>{nameOf(confirm.target)}</b> จะเพิ่ม ลบ และเปลี่ยนสิทธิ์ของคนในโครงการ “{pname}” ได้ รวมถึงแต่งตั้งผู้ดูแลโครงการคนอื่น
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>และแก้ไขเอกสารและข้อมูลของโครงการได้เหมือนผู้มีสิทธิ์แก้ไข</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'demote' && (
        <ConfirmDialog
          title={`เปลี่ยน ${nameOf(confirm.target)} จากผู้ดูแลโครงการ?`}
          confirmLabel={`เปลี่ยนเป็น "${MEMBERSHIP_LABEL[confirm.role]}"`}
          danger
          busy={writing}
          error={confirmErr}
          onConfirm={() => doSet(confirm.target, confirm.role, { origin: confirm.origin, viaConfirm: true })}
          onCancel={() => {
            setConfirm(null)
            setConfirmErr('')
          }}
        >
          <p style={{ marginTop: 0 }}>
            <b>{nameOf(confirm.target)}</b> จะเปลี่ยนเป็น <b>{MEMBERSHIP_LABEL[confirm.role]}</b> และจะเพิ่ม ลบ หรือเปลี่ยนสิทธิ์ของคนในโครงการ “{pname}” ไม่ได้อีก
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>เปลี่ยนกลับเป็นผู้ดูแลโครงการได้ภายหลัง</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'remove' && (
        <ConfirmDialog
          title={`นำ ${nameOf(confirm.target)} ออกจากโครงการ?`}
          confirmLabel="นำออกจากโครงการ"
          danger
          busy={writing}
          error={confirmErr}
          onConfirm={() => doRemove(confirm.target)}
          onCancel={() => {
            setConfirm(null)
            setConfirmErr('')
          }}
        >
          <p style={{ marginTop: 0 }}>
            <b>{nameOf(confirm.target)}</b> จะไม่เห็นโครงการ “{pname}” และเอกสารในโครงการอีก
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>เพิ่มกลับเข้าโครงการได้ภายหลัง</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
