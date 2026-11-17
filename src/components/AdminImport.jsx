import { useId, useMemo, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Dialog, { ConfirmDialog } from './ui/Dialog.jsx'
import { ToneBadge } from './TrackingBits.jsx'
import { copyText } from './AdminCreateUser.jsx'
import {
  adminCreateUser,
  adminListUsers,
  fetchAllMemberships,
  fetchProjectsForImport,
  setMembership,
  setProjectCoIfEmpty,
} from '../api/supabase.js'
import {
  readWorkbook,
  parseImport,
  withoutExistingIds,
  prepareProjectIndex,
  autoMapProjects,
  mappingFromAuto,
  makePersonIndex,
  buildPlan,
  planSignature,
} from '../utils/importPlan.js'
import { runImport, countPlanSteps } from '../utils/importRun.js'
import { ROLE_LABEL } from '../utils/roles.js'

// "นำเข้าจากไฟล์ Excel" — admin only (rendered by AdminConsole). Reads the .xlsx in the browser, shows a PREVIEW
// PLAN and writes only after an explicit confirmation. All rules live in utils/importPlan.js (planning) and
// utils/importRun.js (execution); this file is the UI. Employee ids stay in memory (non-enumerable on the parsed
// people), are never rendered / logged / stored and travel only in the body of the create request; the parsed file
// is dropped as soon as the run has finished.
const MAX_FILE_BYTES = 5 * 1024 * 1024
const PAGE_PEOPLE = 200
const PAGE_PROJECTS = 100
const LAZY_OPTION_CELLS = 20000 // rows x system projects above which a select renders its options only when used
const safeMessage = (err, fallback) => (err && err.name === 'AppError' && err.message ? err.message : fallback)

const projLabel = (p) => `${p.code ? p.code + ' · ' : ''}${p.name}`

async function loadSnapshot() {
  const [users, projects, memberships] = await Promise.all([adminListUsers(), fetchProjectsForImport(), fetchAllMemberships()])
  return { users, projects, memberships }
}

const importDeps = {
  createUser: adminCreateUser,
  refreshUsers: adminListUsers,
  setProjectCo: setProjectCoIfEmpty, // writes project_co only, and only while it is still empty
  setManager: (projectId, userId) => setMembership(projectId, userId, 'manager'),
}

const CO_ACTION = {
  add: { tone: 'ok', text: 'เพิ่มเป็นผู้ดูแลโครงการ' },
  upgrade: { tone: 'info', text: 'ปรับเป็นผู้ดูแลโครงการ' },
  keep: { tone: 'mute', text: 'เป็นผู้ดูแลโครงการอยู่แล้ว' },
  skip_global: { tone: 'mute', text: 'เป็นแอดมิน/ผู้บริหาร — ไม่ต้องมีสิทธิ์รายโครงการ' },
  skip_inactive: { tone: 'warn', text: 'บัญชีปิดการใช้งาน — ข้าม' },
  unmatched: { tone: 'warn', text: 'ไม่พบใน Name List — ข้าม' },
  ambiguous: { tone: 'warn', text: 'ตรงกับหลายคน — ข้าม' },
  candidate: { tone: 'warn', text: 'ชื่อใกล้เคียง — ตรวจสอบ' },
  admin_text: { tone: 'mute', text: 'ทีม Admin — เก็บเป็นข้อความเท่านั้น' },
  duplicate: { tone: 'mute', text: 'ซ้ำในโครงการเดียวกัน — ข้าม' },
  skipped: { tone: 'mute', text: 'ข้ามพร้อมโครงการ' },
}
const MEMBER_ROLE_TEXT = { editor: 'แก้ไขได้', viewer: 'ดูอย่างเดียว' }

function CountChips({ counts }) {
  const items = [
    ['สร้างบัญชีใหม่', counts.peopleCreate, 'ok'],
    ['มีบัญชีแล้ว', counts.peopleExists, 'mute'],
    ['ตั้ง Project Co', counts.coSet, 'info'],
    ['เพิ่มผู้ดูแลโครงการ', counts.mgrAdd, 'ok'],
    ['ปรับเป็นผู้ดูแลโครงการ', counts.mgrUpgrade, 'info'],
    ['โครงการที่ข้าม', counts.projectsSkipped, counts.projectsSkipped ? 'warn' : 'mute'],
    ['คำเตือน', counts.warnings, counts.warnings ? 'warn' : 'mute'],
  ]
  return (
    <ul className="adm-imp-chips" data-testid="import-summary" aria-label="สรุปแผนนำเข้า">
      {items.map(([label, n, tone]) => (
        <li key={label}>
          <ToneBadge tone={tone}>
            {label} <b>{n}</b>
          </ToneBadge>
        </li>
      ))}
    </ul>
  )
}

function PeopleList({ people }) {
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [limit, setLimit] = useState(PAGE_PEOPLE)
  const filtered = onlyChanges ? people.filter((p) => p.status === 'create' || p.warnings.length) : people
  const shown = filtered.slice(0, limit)
  const toggleId = useId()
  return (
    <section aria-labelledby={`${toggleId}-h`} className="adm-section">
      <div className="adm-imp-head">
        <h4 id={`${toggleId}-h`}>บัญชีผู้ใช้ ({people.length} คน)</h4>
        <label className="adm-imp-check small">
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          <span>แสดงเฉพาะที่ต้องสร้างหรือมีคำเตือน</span>
        </label>
      </div>
      <ul className="adm-imp-list" tabIndex={0} aria-label="รายชื่อผู้ใช้ในไฟล์" data-testid="import-people">
        {shown.map((p) => (
          <li key={p.email} className="adm-imp-person" data-testid="import-person" data-email={p.email} data-status={p.status}>
            <div className="adm-imp-who">
              <b>{p.name}</b>
              <span className="muted small adm-imp-mail">{p.email}</span>
            </div>
            <div className="adm-imp-badges">
              <ToneBadge tone={p.role === 'admin' ? 'bad' : 'mute'}>{ROLE_LABEL[p.role]}</ToneBadge>
              {p.status === 'create' ? (
                <>
                  <ToneBadge tone="ok">สร้างใหม่</ToneBadge>
                  <ToneBadge tone="mute">{p.passwordMode === 'id' ? 'รหัสผ่าน: รหัสพนักงาน' : 'รหัสผ่าน: สุ่ม'}</ToneBadge>
                </>
              ) : (
                <ToneBadge tone="mute">มีอยู่แล้ว — ไม่แก้ไข</ToneBadge>
              )}
            </div>
            {p.warnings.map((w) => (
              <div key={w} className="adm-imp-warn small">
                <Icon name="alert" size={12} /> {w}
              </div>
            ))}
          </li>
        ))}
        {shown.length === 0 && <li className="muted small" style={{ padding: 10 }}>ไม่มีรายการ</li>}
      </ul>
      {filtered.length > shown.length && (
        <div className="small muted" style={{ marginTop: 6 }}>
          แสดง {shown.length} จาก {filtered.length} รายการ — รายการที่เหลือนำเข้าตามแผนเช่นเดียวกัน{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((n) => n + PAGE_PEOPLE)}>
            แสดงเพิ่ม
          </button>
        </div>
      )}
    </section>
  )
}

function CoLine({ c, onToggle }) {
  const meta = CO_ACTION[c.action] || { tone: 'mute', text: c.action }
  let text = meta.text
  if (c.action === 'upgrade') text += ` (เดิม: ${MEMBER_ROLE_TEXT[c.current] || c.current})`
  if (c.action === 'skip_global' && c.pending) text = 'จะเป็นแอดมิน — ไม่ต้องมีสิทธิ์รายโครงการ'
  const who = c.name && c.name !== c.raw ? `${c.raw} → ${c.name}` : c.raw
  const near = c.action === 'candidate' ? c.candidate : c.accepted ? { name: c.name } : null
  return (
    <li className="adm-imp-co" data-testid="import-co" data-action={c.action}>
      <span className="adm-imp-co-name">{c.action === 'candidate' ? c.raw : who}</span>
      <ToneBadge tone={meta.tone}>{text}</ToneBadge>
      {c.pending && c.action === 'add' && <ToneBadge tone="mute">บัญชีสร้างในรอบนี้</ToneBadge>}
      {c.accepted && <ToneBadge tone="warn">ชื่อใกล้เคียง — คุณยืนยันเอง</ToneBadge>}
      {near && (
        <label className="adm-imp-check small">
          <input type="checkbox" checked={!!c.accepted} onChange={() => onToggle(c.key)} data-testid="import-co-accept" />
          <span>ใช้ “{near.name}” เป็นผู้ดูแลโครงการนี้</span>
        </label>
      )}
    </li>
  )
}

function ProjectRow({ row, auto, systemProjects, lazy, value, onChange, onToggleCo }) {
  const id = useId()
  const [opened, setOpened] = useState(false)
  const byId = (pid) => systemProjects.find((p) => p.id === pid)
  const cand = (auto?.candidates || []).map((c) => byId(c.id)).filter(Boolean)
  const suggestion = auto?.suggestion ? byId(auto.suggestion.id) : null
  let flag = null
  if (row.skipped) flag = <ToneBadge tone="warn">ต้องเลือก — ข้ามไว้ก่อน</ToneBadge>
  else if (row.matchedBy === 'exact') flag = <ToneBadge tone="ok">ชื่อตรงกัน</ToneBadge>
  else flag = <ToneBadge tone="info">เลือกเอง</ToneBadge>
  const t = row.coText
  const full = !lazy || opened
  const shownProjects = full ? systemProjects : systemProjects.filter((p) => p.id === value)
  return (
    <li className={`adm-imp-proj ${row.skipped ? 'is-skipped' : ''}`} data-testid="import-project" data-row={row.index}>
      <div className="adm-imp-proj-head">
        <b id={`${id}-n`} className="adm-imp-proj-name">
          {row.sheetName}
        </b>
        {flag}
      </div>
      <div className="adm-imp-map">
        <label htmlFor={id} className="small muted">
          โครงการในระบบ
        </label>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(row.index, e.target.value)}
          onFocus={() => setOpened(true)}
          onMouseDown={() => setOpened(true)}
          aria-describedby={`${id}-n`}
          data-testid={`import-map-${row.index}`}
        >
          <option value="">ข้าม (ไม่นำเข้าโครงการนี้)</option>
          {shownProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {projLabel(p)}
            </option>
          ))}
        </select>
      </div>
      {suggestion && value !== suggestion.id && (
        <div className="adm-imp-suggest small" data-testid="import-suggestion">
          <span className="muted">ชื่อใกล้เคียง (ยังไม่ได้เลือก):</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(row.index, suggestion.id)} data-testid={`import-suggest-${row.index}`}>
            ใช้ {projLabel(suggestion)} ?
          </button>
        </div>
      )}
      {row.skipped ? (
        <div className="small muted">
          ไม่แก้ไขโครงการนี้
          {!suggestion && cand.length > 0 && <> · ใกล้เคียง: {cand.map(projLabel).join(' / ')}</>}
        </div>
      ) : (
        <>
          <div className="adm-imp-coText small" data-testid="import-cotext" data-action={t.action}>
            <span className="muted">Project Co (ข้อความ): </span>
            {t.action === 'set' && (
              <>
                <ToneBadge tone="ok">จะตั้งเป็น</ToneBadge> <b>{t.value}</b>
              </>
            )}
            {t.action === 'keep' && <ToneBadge tone="mute">มีอยู่แล้ว — ไม่แก้</ToneBadge>}
            {t.action === 'none' && <span className="muted">ไฟล์ไม่ระบุ Project Co</span>}
          </div>
          {row.co.length > 0 && (
            <ul className="adm-imp-colist" aria-label="ผู้ประสานงาน (Project Co) ของโครงการ">
              {row.co.map((c, i) => (
                <CoLine key={i} c={c} onToggle={onToggleCo} />
              ))}
            </ul>
          )}
          {row.changes === 0 && (
            <div className="small" data-testid="import-nothing">
              <ToneBadge tone="mute">ไม่มีอะไรต้องทำ</ToneBadge>
            </div>
          )}
        </>
      )}
    </li>
  )
}

function stepIcon(status) {
  return status === 'ok' ? '✓' : status === 'fail' ? '✗' : status === 'skip' ? '–' : '…'
}

const emptyResult = (message, steps, mode) => ({
  total: 0,
  steps,
  created: [],
  existed: [],
  failedPeople: [],
  coSet: 0,
  coKept: 0,
  coFailed: [],
  managerOk: [],
  managerFailed: [],
  managerSkipped: [],
  stopped: { code: 'unexpected', message },
  ok: 0,
  failed: 0,
  skipped: 0,
  notRun: 0,
  done: 0,
  mode,
  existsCount: 0,
})

export default function AdminImport({ onClose, onDone }) {
  const [stage, setStage] = useState('pick') // pick | preview | running | result
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [snap, setSnap] = useState(null)
  const [auto, setAuto] = useState([])
  const [mapping, setMapping] = useState({})
  const [accepted, setAccepted] = useState([]) // keys of near-name Co candidates the admin ticked
  const [idPw, setIdPw] = useState(true)
  const [adminRandom, setAdminRandom] = useState(false)
  const [projLimit, setProjLimit] = useState(PAGE_PROJECTS)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [ack, setAck] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState([])
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState('')
  const busyRef = useRef(false)
  const fileId = useId()
  const optId = useId()
  const ackId = useId()

  const personIndex = useMemo(() => (parsed ? makePersonIndex(parsed.people) : null), [parsed])
  const plan = useMemo(
    () =>
      parsed && snap
        ? buildPlan({ parsed, ...snap, mapping, useIdPassword: idPw, adminRandomPassword: adminRandom, acceptedCandidates: accepted, auto, personIndex })
        : null,
    [parsed, snap, mapping, idPw, adminRandom, accepted, auto, personIndex]
  )
  const totalSteps = plan ? countPlanSteps(plan) : 0
  const lazyOptions = !!(plan && snap && plan.projects.length * snap.projects.length > LAZY_OPTION_CELLS)

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // the same file can be chosen again
    if (!file || loading) return
    setError('')
    setNotice('')
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
      setError('เลือกไฟล์ Excel นามสกุล .xlsx เท่านั้น')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('ไฟล์ใหญ่เกินไป (สูงสุด 5 MB)')
      return
    }
    setLoading(true)
    try {
      const wbk = await readWorkbook(await file.arrayBuffer()) // throws a Thai message for oversized / unreadable files
      const p0 = parseImport(wbk)
      if (!p0.people.length && !p0.projects.length) throw new Error('ไม่พบข้อมูลที่นำเข้าได้ในไฟล์นี้ (ตรวจสอบชีต Project List และ Name List)')
      let s
      try {
        s = await loadSnapshot()
      } catch (err) {
        throw new Error(safeMessage(err, 'โหลดข้อมูลผู้ใช้/โครงการจากระบบไม่สำเร็จ — ลองใหม่อีกครั้ง'))
      }
      const p = withoutExistingIds(p0, s.users) // ids of people who already exist are not needed
      const a = autoMapProjects(p.projects, prepareProjectIndex(s.projects))
      setParsed(p)
      setSnap(s)
      setAuto(a)
      setMapping(mappingFromAuto(a))
      setAccepted([])
      setProjLimit(PAGE_PROJECTS)
      setSheets(wbk.sheets || null)
      setFileName(file.name)
      setStage('preview')
    } catch (err) {
      setError(err?.message || 'อ่านไฟล์ไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    if (busyRef.current) return
    setStage('pick')
    setParsed(null)
    setSnap(null)
    setResult(null)
    setSteps([])
    setError('')
    setNotice('')
  }

  const toggleCo = (key) => setAccepted((l) => (l.includes(key) ? l.filter((k) => k !== key) : [...l, key]))

  const openConfirm = () => {
    setAck(false)
    setConfirmError('')
    setConfirmOpen(true)
  }

  const needAck = !!plan && plan.counts.peopleCreateAdminWithId > 0

  const start = async () => {
    if (busyRef.current || !plan) return
    if (needAck && !ack) return
    busyRef.current = true
    setBusy(true)
    setConfirmError('')
    const mode = idPw ? 'id' : 'random'
    let liveSteps = []
    try {
      // the system may have changed since the preview: re-read and compare before writing anything
      let fresh
      try {
        fresh = await loadSnapshot()
      } catch (err) {
        setConfirmError(safeMessage(err, 'โหลดข้อมูลจากระบบไม่สำเร็จ — ยังไม่ได้ทำอะไร ลองใหม่อีกครั้ง'))
        return
      }
      const freshParsed = withoutExistingIds(parsed, fresh.users)
      const freshPlan = buildPlan({ parsed: freshParsed, ...fresh, mapping, useIdPassword: idPw, adminRandomPassword: adminRandom, acceptedCandidates: accepted, auto, personIndex })
      if (planSignature(freshPlan) !== planSignature(plan)) {
        setSnap(fresh)
        setParsed(freshParsed)
        setConfirmOpen(false)
        setNotice('ข้อมูลในระบบเปลี่ยนไประหว่างที่ดูตัวอย่าง จึงคำนวณแผนใหม่ — ตรวจสอบอีกครั้งแล้วกดยืนยัน (ยังไม่ได้ทำอะไร)')
        return
      }
      if (!freshPlan.canConfirm) {
        setConfirmError(freshPlan.blockers[0])
        return
      }
      setConfirmOpen(false)
      setSteps([])
      setStage('running')
      const existsCount = freshPlan.counts.peopleExists
      const res = await runImport({
        plan: freshPlan,
        parsed: freshParsed,
        deps: importDeps,
        onStep: (s) => {
          liveSteps = liveSteps.some((x) => x.id === s.id) ? liveSteps.map((x) => (x.id === s.id ? s : x)) : [...liveSteps, s]
          setSteps(liveSteps)
        },
      })
      setResult({ ...res, mode, existsCount })
      setParsed(null) // the parsed file (and the employee ids in it) is dropped once the run is over
      setSnap(null)
      setStage('result')
      onDone?.()
    } catch {
      // never leave the dialog stuck on "running"
      setConfirmOpen(false)
      setResult(emptyResult('เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างนำเข้า — ตรวจสอบรายชื่อผู้ใช้ในหน้านี้ก่อนลองใหม่ (รายการที่ทำแล้วจะไม่ถูกทำซ้ำ)', liveSteps, mode))
      setParsed(null)
      setSnap(null)
      setStage('result')
      onDone?.()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const copy = async (key, text) => {
    const ok = await copyText(text)
    setCopied(ok ? key : '')
  }

  const running = stage === 'running'
  const tempList = (result?.created || []).filter((c) => c.temporaryPassword)
  // the displayed passwords can not be dismissed by accident: only the explicit button closes the result
  const lockedResult = stage === 'result' && tempList.length > 0
  const c = plan?.counts

  let body
  let footer
  if (stage === 'pick') {
    body = (
      <div className="modal-body">
        <p>
          เลือกไฟล์ Excel (.xlsx) ที่มีชีต <b>Project List</b> (ชื่อโครงการ, Project Co.1, Project Co.2) และ <b>Name List</b> (NO., Name-Sername, Email, ID, หมายเหตุ)
          ระบบจะอ่านไฟล์ในเครื่องของคุณและแสดง <b>ตัวอย่างแผน</b> ก่อน — ยังไม่มีอะไรถูกบันทึกจนกว่าจะกดยืนยัน
        </p>
        <div className="field">
          <label htmlFor={fileId}>ไฟล์ Excel (.xlsx)</label>
          <input id={fileId} type="file" accept=".xlsx,.xlsm" onChange={onFile} disabled={loading} data-testid="import-file" data-autofocus />
        </div>
        <div className="adm-note">
          <Icon name="info" size={14} />
          <span>
            บัญชีที่มีอีเมลอยู่แล้วจะไม่ถูกแก้ไข · คอลัมน์หมายเหตุที่เป็นคำว่า Admin ทั้งช่อง = สร้างเป็นแอดมิน นอกนั้นเป็นสมาชิก · Project Co ที่ชื่อตรงกับ Name List ทุกตัวอักษรจะถูกตั้งเป็นผู้ดูแลโครงการ
          </span>
        </div>
        {loading && (
          <div role="status" className="small muted" style={{ marginTop: 10 }}>
            กำลังอ่านไฟล์และโหลดข้อมูลจากระบบ...
          </div>
        )}
        {error && (
          <div className="auth-msg err" role="alert" style={{ marginTop: 12, marginBottom: 0 }} data-testid="import-error">
            {error}
          </div>
        )}
      </div>
    )
    footer = (
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
        ปิด
      </button>
    )
  } else if (stage === 'preview' && plan) {
    const noWork = plan.empty
    const hasAdmins = plan.counts.peopleCreateAdmin > 0
    body = (
      <div className="modal-body adm-imp-body">
        <div className="small muted" style={{ marginBottom: 8 }} data-testid="import-file-info">
          ไฟล์: <b>{fileName}</b>
          {sheets && (
            <>
              {' '}
              · ชีตโครงการ: <b>{sheets.project}</b> · ชีตรายชื่อ: <b>{sheets.people}</b>
            </>
          )}{' '}
          — ตัวอย่างแผน ยังไม่ได้บันทึกอะไร
        </div>
        {notice && (
          <div className="adm-note warn" role="status" data-testid="import-notice">
            <Icon name="alert" size={14} />
            <span>{notice}</span>
          </div>
        )}
        {plan.blockers.length > 0 && (
          <div className="auth-msg err" role="alert" data-testid="import-blockers">
            {plan.blockers.map((b, i) => (
              <div key={i}>{b}</div>
            ))}
          </div>
        )}
        <CountChips counts={c} />
        {noWork && (
          <div className="adm-note" role="status" data-testid="import-empty">
            <Icon name="check" size={14} />
            <span>
              <b>ไม่มีอะไรต้องทำ</b> — ทุกรายการในไฟล์มีอยู่ในระบบแล้ว (หรือยังไม่ได้เลือกโครงการ)
            </span>
          </div>
        )}

        <div className="adm-imp-opt">
          <label className="adm-imp-check" htmlFor={optId}>
            <input id={optId} type="checkbox" checked={idPw} onChange={(e) => setIdPw(e.target.checked)} data-testid="import-use-id" />
            <span>ใช้รหัสพนักงาน (คอลัมน์ ID) เป็นรหัสผ่านเริ่มต้น</span>
          </label>
          <div className="small muted">
            {idPw
              ? 'แต่ละคนยังต้องตั้งรหัสผ่านใหม่เองเมื่อเข้าสู่ระบบครั้งแรก · ไม่แสดงรหัสพนักงานบนหน้าจอ · ถ้าไม่มีรหัสพนักงานหรืออ่านค่าไม่ได้จะใช้รหัสสุ่มให้คนนั้น · Supabase อาจกำหนดความยาวรหัสผ่านขั้นต่ำไว้สูงกว่าที่รหัสพนักงานมี (เช่น รหัส 7 ตัว) — ถ้าถูกปฏิเสธ ระบบจะรายงานเป็นรายคน'
              : 'ระบบสุ่มรหัสผ่านชั่วคราวให้แต่ละคน แสดงครั้งเดียวในรายงานผลหลังนำเข้า พร้อมปุ่มคัดลอก'}
          </div>
          <label className="adm-imp-check" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={adminRandom}
              disabled={!idPw}
              onChange={(e) => setAdminRandom(e.target.checked)}
              data-testid="import-admin-random"
            />
            <span>ใช้รหัสสุ่มสำหรับแอดมิน (แนะนำ)</span>
          </label>
          <div className="small muted">
            {hasAdmins
              ? `มีผู้ที่จะถูกสร้างเป็นแอดมิน ${plan.counts.peopleCreateAdmin} คน — แอดมินที่ใช้รหัสพนักงานเป็นรหัสเริ่มต้นเสี่ยงถูกยึดบัญชีได้ก่อนเจ้าตัวเข้าสู่ระบบ`
              : 'ใช้เฉพาะบัญชีที่จะสร้างเป็นแอดมิน (บทบาท admin) — คนอื่นยังใช้รหัสพนักงานตามตัวเลือกด้านบน'}
          </div>
        </div>

        {plan.warnings.length > 0 && (
          <details className="adm-imp-warns" data-testid="import-warnings">
            <summary>
              <Icon name="alert" size={14} /> คำเตือน ({plan.warnings.length})
            </summary>
            <ul>
              {plan.warnings.slice(0, 500).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {plan.warnings.length > 500 && <li>… และอีก {plan.warnings.length - 500} รายการ</li>}
            </ul>
          </details>
        )}

        <PeopleList people={plan.people} />

        <section aria-labelledby={`${optId}-p`} className="adm-section">
          <h4 id={`${optId}-p`}>โครงการ ({plan.projects.length} รายการในไฟล์)</h4>
          <div className="small muted" style={{ marginBottom: 8 }}>
            ระบบเลือกโครงการให้เฉพาะที่ชื่อตรงกันทุกตัวอักษร (ไม่นับเว้นวรรค/ตัวพิมพ์) — ชื่อใกล้เคียงต้องกดยืนยันเองทีละแถว แถวที่ยังไม่เลือกจะถูกข้ามและไม่ถูกแก้ไข
          </div>
          <ul className="adm-imp-projlist">
            {plan.projects.slice(0, projLimit).map((row) => (
              <ProjectRow
                key={row.index}
                row={row}
                auto={auto.find((a) => a.index === row.index)}
                systemProjects={snap.projects}
                lazy={lazyOptions}
                value={mapping[row.index] || ''}
                onChange={(i, v) => setMapping((m) => ({ ...m, [i]: v }))}
                onToggleCo={toggleCo}
              />
            ))}
          </ul>
          {plan.projects.length > projLimit && (
            <div className="small muted" style={{ marginTop: 8 }}>
              แสดง {projLimit} จาก {plan.projects.length} โครงการ — ที่เหลือนำเข้าตามแผนเช่นเดียวกัน{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProjLimit((n) => n + PAGE_PROJECTS)}>
                แสดงเพิ่ม
              </button>
            </div>
          )}
        </section>
      </div>
    )
    footer = (
      <>
        <button type="button" className="btn btn-ghost" onClick={reset}>
          เลือกไฟล์อื่น
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          ยกเลิก
        </button>
        <button type="button" className="btn btn-primary" onClick={openConfirm} disabled={noWork || !plan.canConfirm} data-testid="import-confirm">
          <Icon name="check" size={14} /> ยืนยันนำเข้า
        </button>
      </>
    )
  } else if (running) {
    const done = steps.filter((s) => s.status !== 'running').length
    const current = steps.find((s) => s.status === 'running')
    body = (
      <div className="modal-body" data-testid="import-running">
        <div role="status" aria-live="polite" className="adm-imp-status">
          กำลังนำเข้า {done} / {totalSteps} ขั้นตอน{current ? ` — ${current.label}` : ''}
        </div>
        <div
          className="adm-imp-bar"
          role="progressbar"
          aria-label="ความคืบหน้าการนำเข้า"
          aria-valuemin={0}
          aria-valuemax={totalSteps}
          aria-valuenow={done}
        >
          <span style={{ width: `${totalSteps ? Math.min(100, (done / totalSteps) * 100) : 0}%` }} />
        </div>
        <div className="small muted" style={{ margin: '8px 0' }}>
          อย่าปิดหน้านี้จนกว่าจะเสร็จ — ดำเนินการทีละขั้นตอน
        </div>
        <ul className="adm-imp-steps" tabIndex={0} aria-label="ขั้นตอนที่ดำเนินการ">
          {steps.map((s) => (
            <li key={s.id} className={`st-${s.status}`}>
              <span aria-hidden="true">{stepIcon(s.status)}</span> {s.label}
              {s.detail && s.status !== 'ok' ? <span className="muted"> — {s.detail}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    )
    footer = (
      <button type="button" className="btn btn-ghost" disabled>
        กำลังนำเข้า...
      </button>
    )
  } else if (stage === 'result' && result) {
    const r = result
    const failedCount = r.failedPeople.length + r.coFailed.length + r.managerFailed.length
    body = (
      <div className="modal-body" data-testid="import-result">
        {r.stopped ? (
          <div className="auth-msg err" role="alert" data-testid="import-stopped">
            <b>การนำเข้าหยุดกลางคัน</b> — {r.stopped.message}
            <br />
            สำเร็จ {r.ok} · ไม่สำเร็จ {r.failed} · ข้าม {r.skipped} · ยังไม่ได้ทำ {r.notRun} (รวม {r.total} ขั้นตอน) — ตรวจสอบรายการด้านล่าง แล้วเปิดเครื่องมือนี้อีกครั้งเมื่อแก้ไขเรียบร้อย
            รายการที่ทำแล้วจะไม่ถูกทำซ้ำ
          </div>
        ) : failedCount ? (
          <div className="auth-msg err" role="status">
            นำเข้าเสร็จ แต่มี {failedCount} รายการที่ไม่สำเร็จ — ดูรายละเอียดด้านล่าง
          </div>
        ) : (
          <div className="auth-msg ok" role="status">
            นำเข้าเรียบร้อย
          </div>
        )}
        <ul className="adm-imp-chips" data-testid="import-result-counts">
          <li><ToneBadge tone="ok">สร้างบัญชี <b>{r.created.length}</b></ToneBadge></li>
          <li><ToneBadge tone="mute">มีอยู่แล้ว/ข้าม <b>{r.existed.length + (r.existsCount || 0)}</b></ToneBadge></li>
          <li><ToneBadge tone="ok">ตั้ง Project Co <b>{r.coSet}</b></ToneBadge></li>
          <li><ToneBadge tone="ok">ผู้ดูแลโครงการ <b>{r.managerOk.length}</b></ToneBadge></li>
          <li><ToneBadge tone={failedCount ? 'bad' : 'mute'}>ไม่สำเร็จ <b>{failedCount}</b></ToneBadge></li>
        </ul>

        {r.failedPeople.length > 0 && (
          <section className="adm-section" aria-label="บัญชีที่สร้างไม่สำเร็จ">
            <h4>บัญชีที่สร้างไม่สำเร็จ</h4>
            <ul className="adm-imp-list" data-testid="import-failed">
              {r.failedPeople.map((f) => (
                <li key={f.email} className="adm-imp-person" data-code={f.code}>
                  <div className="adm-imp-who">
                    <b>{f.name}</b> <span className="muted small adm-imp-mail">{f.email}</span>
                  </div>
                  <div className="adm-imp-warn small">
                    <Icon name="alert" size={12} /> {f.message}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(r.coFailed.length > 0 || r.managerFailed.length > 0 || r.managerSkipped.length > 0) && (
          <section className="adm-section" aria-label="รายการโครงการที่ไม่สำเร็จหรือข้าม">
            <h4>โครงการที่ไม่สำเร็จหรือข้าม</h4>
            <ul className="adm-imp-list" data-testid="import-failed-projects">
              {r.coFailed.map((f, i) => (
                <li key={`c${i}`} className="adm-imp-person">
                  <b>{f.project}</b> — Project Co: {f.message}
                </li>
              ))}
              {r.managerFailed.map((f, i) => (
                <li key={`m${i}`} className="adm-imp-person">
                  <b>{f.project}</b> — {f.name}: {f.message}
                </li>
              ))}
              {r.managerSkipped.map((f, i) => (
                <li key={`s${i}`} className="adm-imp-person">
                  <b>{f.project}</b> — {f.name}: {f.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        {r.created.length > 0 && (
          <section className="adm-section" aria-label="บัญชีที่สร้าง">
            <h4>บัญชีที่สร้างแล้ว ({r.created.length})</h4>
            {r.mode === 'id' && r.created.some((x) => x.passwordMode === 'id') && (
              <div className="adm-note warn">
                <Icon name="alert" size={14} />
                <span>
                  ผู้ใช้ที่สร้างด้วยรหัสพนักงานเป็นรหัสผ่านเริ่มต้นต้องเข้าสู่ระบบและตั้งรหัสผ่านใหม่ — แจ้งทุกคนให้เข้าสู่ระบบและเปลี่ยนรหัสผ่านภายในวันนี้
                </span>
              </div>
            )}
            <ul className="adm-imp-list" data-testid="import-created">
              {r.created.map((x) => (
                <li key={x.email} className="adm-imp-person" data-email={x.email}>
                  <div className="adm-imp-who">
                    <b>{x.name}</b> <span className="muted small adm-imp-mail">{x.email}</span>
                  </div>
                  <div className="adm-imp-badges">
                    <ToneBadge tone={x.role === 'admin' ? 'bad' : 'mute'}>{ROLE_LABEL[x.role]}</ToneBadge>
                    <ToneBadge tone="mute">{x.passwordMode === 'id' ? 'รหัสพนักงาน' : 'รหัสสุ่ม'}</ToneBadge>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tempList.length > 0 && (
          <section className="adm-section" aria-label="รหัสผ่านชั่วคราว" data-testid="import-temp-passwords">
            <h4>รหัสผ่านชั่วคราว (แสดงครั้งเดียว)</h4>
            <div className="adm-note warn">
              <Icon name="alert" size={14} />
              <span>ระบบไม่เก็บรหัสเหล่านี้ไว้ — คัดลอกส่งให้แต่ละคนก่อนปิดหน้านี้ ผู้ใช้ต้องตั้งรหัสผ่านใหม่เมื่อเข้าสู่ระบบครั้งแรก</span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => copy('all', tempList.map((x) => `${x.email}\t${x.temporaryPassword}`).join('\n'))}
                data-testid="import-copy-all"
              >
                <Icon name={copied === 'all' ? 'check' : 'copy'} size={13} /> {copied === 'all' ? 'คัดลอกแล้ว' : 'คัดลอกทั้งหมด (อีเมล + รหัสผ่าน)'}
              </button>
            </div>
            <ul className="adm-imp-list">
              {tempList.map((x) => (
                <li key={x.email} className="adm-imp-person adm-imp-temp">
                  <div className="adm-imp-who">
                    <b>{x.name}</b> <span className="muted small adm-imp-mail">{x.email}</span>
                  </div>
                  <code className="adm-imp-pw" data-testid="import-temp-password">{x.temporaryPassword}</code>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(x.email, x.temporaryPassword)} aria-label={`คัดลอกรหัสผ่านของ ${x.name}`}>
                    <Icon name={copied === x.email ? 'check' : 'copy'} size={13} /> {copied === x.email ? 'คัดลอกแล้ว' : 'คัดลอก'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="adm-imp-warns" style={{ marginTop: 12 }}>
          <summary>ขั้นตอนทั้งหมด ({r.steps.length})</summary>
          <ul className="adm-imp-steps">
            {r.steps.map((s) => (
              <li key={s.id} className={`st-${s.status}`}>
                <span aria-hidden="true">{stepIcon(s.status)}</span> {s.label}
                {s.detail && s.status !== 'ok' ? <span className="muted"> — {s.detail}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      </div>
    )
    footer = (
      <button type="button" className="btn btn-primary" onClick={onClose} data-testid="import-close">
        {tempList.length ? 'ปิด (รหัสผ่านจะไม่แสดงอีก)' : 'ปิด'}
      </button>
    )
  }

  return (
    <Dialog
      title="นำเข้าจากไฟล์ Excel"
      onClose={onClose}
      closable={!running && !loading && !busy && !lockedResult}
      size="lg"
      className="adm-imp"
      initialFocus={stage === 'pick' ? '[data-autofocus]' : undefined}
      footer={footer}
    >
      {body}
      {confirmOpen && plan && (
        <ConfirmDialog
          title="ยืนยันนำเข้า"
          confirmLabel="ยืนยันนำเข้า"
          busy={busy}
          confirmDisabled={needAck && !ack}
          error={confirmError}
          onConfirm={start}
          onCancel={() => setConfirmOpen(false)}
        >
          <p data-testid="import-confirm-text">
            จะสร้างบัญชีใหม่ <b>{c.peopleCreate}</b> คน (แอดมิน {c.peopleCreateAdmin}) · ตั้ง Project Co <b>{c.coSet}</b> โครงการ · เพิ่มผู้ดูแลโครงการ <b>{c.mgrAdd}</b> ·
            ปรับเป็นผู้ดูแลโครงการ <b>{c.mgrUpgrade}</b> · ข้าม {c.projectsSkipped} โครงการ
          </p>
          <p data-testid="import-confirm-match">
            โครงการที่จะแก้ไข {c.projectsMapped} รายการ: ชื่อตรงกันทุกตัวอักษร <b>{c.projectsExact}</b> · คุณเลือกเอง <b>{c.projectsManual}</b>
          </p>
          {c.peopleCreate > 0 && (
            <p>
              รหัสผ่านเริ่มต้น:{' '}
              {idPw ? (
                <>
                  <b>รหัสพนักงาน</b> {c.peopleCreateWithId} คน{c.peopleCreateRandom > 0 && <>, รหัสสุ่ม {c.peopleCreateRandom} คน</>}
                </>
              ) : (
                <b>รหัสสุ่ม ({c.peopleCreateRandom} คน) แสดงครั้งเดียวหลังนำเข้า</b>
              )}
            </p>
          )}
          {plan.globalAdmins.length > 0 && (
            <div className="adm-note warn" data-testid="import-admin-list">
              <Icon name="alert" size={14} />
              <span>
                <b>จะสร้างเป็นแอดมินของระบบ ({plan.globalAdmins.length} คน)</b> — เห็นและแก้ไขได้ทุกโครงการ:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {plan.globalAdmins.map((a) => (
                    <li key={a.email} style={{ overflowWrap: 'anywhere' }}>
                      {a.name} · {a.email} · {a.passwordMode === 'id' ? 'รหัสผ่าน: รหัสพนักงาน' : 'รหัสผ่าน: สุ่ม'}
                    </li>
                  ))}
                </ul>
              </span>
            </div>
          )}
          {needAck && (
            <label className="adm-imp-check" htmlFor={ackId} style={{ alignItems: 'flex-start', margin: '10px 0' }}>
              <input id={ackId} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="import-admin-ack" style={{ marginTop: 4 }} />
              <span className="small">
                เข้าใจว่าแอดมินที่ใช้รหัสพนักงานเป็นรหัสเริ่มต้น ใครรู้อีเมลและรหัสพนักงานจะล็อกอินยึดบัญชีได้ก่อนเจ้าตัว — ให้เจ้าตัวล็อกอินและเปลี่ยนรหัสทันทีหลังนำเข้า
              </span>
            </label>
          )}
          {idPw && c.peopleCreateWithId > 0 && (
            <div className="adm-note warn" style={{ marginBottom: 0 }} data-testid="import-id-warning">
              <Icon name="alert" size={14} />
              <span>
                รหัสพนักงานเดาได้ง่ายจนกว่าแต่ละคนจะเปลี่ยนรหัสผ่านตอนเข้าสู่ระบบครั้งแรก — แจ้งทุกคนให้เข้าสู่ระบบและเปลี่ยนรหัสผ่านภายในวันนี้
              </span>
            </div>
          )}
        </ConfirmDialog>
      )}
    </Dialog>
  )
}
