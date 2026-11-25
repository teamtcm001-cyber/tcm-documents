import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Dialog from './ui/Dialog.jsx'
import { useToast } from './Toast.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { getSignedFileUrls, logActivity, fetchProjectFilesForZip } from '../api/supabase.js'
import { normalizeFile, computeIsLatest } from '../utils/format.js'
import {
  fmtBytes, planZip, pickSaveTarget, runZipDownload, zipFileName, blobCapMessage, supportsDiskStreaming,
  LARGE_ZIP_FILES, LARGE_ZIP_BYTES,
} from '../utils/zipDownload.js'

const FORCE_CLOSE_AFTER_MS = 15000 // Cancel was pressed but the run still has not ended: offer a hard close
const LOG_TIMEOUT_MS = 8000

// Download documents as one zip (see src/utils/zipDownload.js).
//
//   const zip = useZipDownload()
//   zip.begin({ files, projectCode, scope, confirm })   // a list the caller already has (an explicit selection)
//   zip.beginProject(project)                           // the latest version of EVERY document of a project (read fresh, paged)
//   ... {zip.dialog}
//
// confirm: true  -> a dialog first shows the count, total size and the size rules; its button starts the run
// confirm: false -> the run starts straight away (an explicit selection needs no extra question), unless the zip is
//                   large (many files / many GB): then the confirm dialog warns first
// Either way the save dialog of Chrome / Edge is opened synchronously inside the click that starts the run
// (the browser demands a user gesture for it).
export function useZipDownload() {
  const { canEditProject } = useAuth()
  const toast = useToast()
  const [state, setState] = useState(null) // null | { req, phase: confirm|running|finished, progress, result, cancelling }
  const [preparing, setPreparing] = useState(false) // reading a project's file list for beginProject
  const ctrlRef = useRef(null)
  const lockRef = useRef(false) // one run at a time, whatever the clicks do
  const prepRef = useRef(false)
  const runIdRef = useRef(0) // a run that was force-closed must not touch the screen when it finally ends
  const aliveRef = useRef(true)
  const lastEmit = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runIdRef.current += 1
      ctrlRef.current?.abort() // the screen went away: stop fetching
    }
  }, [])

  // leaving / reloading the page would silently kill a running download: ask first (not once it is finished)
  const running = state?.phase === 'running'
  useEffect(() => {
    if (!running) return undefined
    const guard = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [running])

  const start = useCallback(
    (req) => {
      if (lockRef.current) return
      lockRef.current = true
      const runId = ++runIdRef.current
      const plan = planZip(req.files)
      const zipName = zipFileName({ projectCode: req.projectCode })
      // SYNCHRONOUS (user gesture): opens the "save as" dialog where the browser has one
      const target = pickSaveTarget(zipName)
      const ctrl = new AbortController()
      ctrlRef.current = ctrl
      setState({ req, phase: 'running', progress: { index: 0, total: plan.count, name: '', bytes: 0, estimate: plan.totalBytes, ok: 0, failed: 0 }, result: null, zipName, cancelling: false })

      runZipDownload({
        files: plan.files,
        zipName,
        target,
        signal: ctrl.signal,
        getUrls: getSignedFileUrls,
        onProgress: (p) => {
          if (runIdRef.current !== runId) return
          const now = Date.now()
          if (now - lastEmit.current < 120 && p.index !== plan.count) return
          lastEmit.current = now
          if (aliveRef.current) setState((s) => (s ? { ...s, progress: p } : s))
        },
      }).then((result) => {
        if (runIdRef.current !== runId) return // force-closed meanwhile
        if (ctrlRef.current === ctrl) ctrlRef.current = null
        lockRef.current = false
        // 1. the screen first: the person must never wait for (or be blocked by) the audit write
        if (aliveRef.current) {
          if (result.status === 'cancelled' && result.silent) setState(null) // closed the browser's save dialog: nothing to report
          else setState((s) => (s ? { ...s, phase: 'finished', result } : s))
        }
        // 2. audit trail, best effort, never awaited by the UI: one row per project that got files ("N files",
        //    no names). Only people who may write activity (RLS) - a viewer's / executive's download is not logged.
        if (result.status === 'done' && result.ok > 0) {
          const okSet = new Set(result.okIds.map(String))
          const perProject = new Map()
          for (const f of plan.files) {
            if (!okSet.has(String(f.id)) || !f.projectId) continue
            perProject.set(f.projectId, (perProject.get(f.projectId) || 0) + 1)
          }
          for (const [pid, n] of perProject) {
            if (!canEditProject(pid)) continue
            Promise.race([
              logActivity(pid, 'download_zip', `ดาวน์โหลด Zip ${n} ไฟล์`),
              new Promise((_, rej) => setTimeout(() => rej(new Error('log timeout')), LOG_TIMEOUT_MS)),
            ]).catch(() => {
              /* the download itself succeeded; the log is best effort */
            })
          }
        }
      })
    },
    [canEditProject]
  )

  const begin = useCallback(
    (req) => {
      if (lockRef.current) return false
      const plan = planZip(req.files)
      if (plan.count === 0) return false
      // a large archive, or one the Blob fallback cannot hold, is confirmed (or refused) in the dialog instead of starting at once
      if (req.confirm || plan.large || plan.overCap) {
        setState((s) => (s ? s : { req, phase: 'confirm' }))
        return true
      }
      start(req)
      return true
    },
    [start]
  )

  // "Zip ทั้งโครงการ": the latest version of every document, read fresh and COMPLETE (paged; no content_text),
  // so the confirm dialog shows the true count.
  const beginProject = useCallback(
    async (project) => {
      if (lockRef.current || prepRef.current || !project) return
      prepRef.current = true
      setPreparing(true)
      try {
        const rows = (await fetchProjectFilesForZip(project.id)).map(normalizeFile)
        computeIsLatest(rows)
        const latest = rows.filter((f) => f.isLatest)
        if (!aliveRef.current) return
        if (latest.length === 0) {
          toast('โครงการนี้ยังไม่มีเอกสาร', 'err')
          return
        }
        begin({ files: latest, projectCode: project.code, scope: `ไฟล์เวอร์ชันล่าสุดทั้งโครงการ ${project.code}`, confirm: true })
      } catch (err) {
        if (aliveRef.current) toast('อ่านรายการไฟล์ไม่สำเร็จ: ' + (err?.message || ''), 'err')
      } finally {
        prepRef.current = false
        if (aliveRef.current) setPreparing(false)
      }
    },
    [begin, toast]
  )

  const cancel = () => {
    if (!ctrlRef.current) return
    ctrlRef.current.abort()
    setState((s) => (s ? { ...s, cancelling: true } : s))
  }
  // last resort after a Cancel that did not end the run: drop the dialog, abort everything, forget the run
  const forceClose = () => {
    runIdRef.current += 1
    ctrlRef.current?.abort()
    ctrlRef.current = null
    lockRef.current = false
    setState(null)
  }
  const close = () => {
    if (lockRef.current) return
    setState(null)
  }

  const dialog = state ? <ZipDownloadDialog state={state} onStart={() => start(state.req)} onCancel={cancel} onClose={close} onForceClose={forceClose} /> : null
  return { begin, beginProject, dialog, busy: !!state || preparing, preparing }
}

function ZipDownloadDialog({ state, onStart, onCancel, onClose, onForceClose }) {
  const { req, phase } = state
  if (phase === 'confirm') return <ConfirmPhase req={req} onStart={onStart} onClose={onClose} />
  if (phase === 'running') return <RunningPhase state={state} onCancel={onCancel} onForceClose={onForceClose} />
  return <FinishedPhase state={state} onClose={onClose} />
}

function Sizes({ plan }) {
  return (
    <>
      <strong>{plan.count} ไฟล์</strong> · ขนาดรวมประมาณ <strong>{fmtBytes(plan.totalBytes)}</strong>
    </>
  )
}

function ConfirmPhase({ req, onStart, onClose }) {
  const plan = planZip(req.files)
  const fs = supportsDiskStreaming()
  const name = zipFileName({ projectCode: req.projectCode })
  return (
    <Dialog
      title="ดาวน์โหลดเป็น Zip"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} data-cancel>
            ยกเลิก
          </button>
          <button type="button" className="btn btn-primary" onClick={onStart} disabled={plan.overCap} data-autofocus>
            <Icon name="zip" size={14} /> ดาวน์โหลด Zip
          </button>
        </>
      }
    >
      <div className="modal-body" data-testid="zip-confirm">
        <p>
          {req.scope ? <>{req.scope}: </> : null}
          <Sizes plan={plan} />
        </p>
        <p className="muted small">ชื่อไฟล์: {name}</p>
        {fs ? (
          <p className="muted small">ระบบจะให้เลือกที่บันทึกไฟล์ แล้วเขียนลงเครื่องโดยตรงทีละไฟล์ จึงรวมไฟล์ขนาดใหญ่ได้</p>
        ) : (
          <p className="muted small">
            เบราว์เซอร์นี้รวมไฟล์ในหน่วยความจำก่อนบันทึก จึงรวมได้ไม่เกิน {fmtBytes(plan.capBytes)} — ถ้าใหญ่กว่านั้นให้เลือกไฟล์น้อยลง หรือใช้ Chrome / Edge บนคอมพิวเตอร์
          </p>
        )}
        {plan.large && (
          <div className="auth-msg" role="note" data-testid="zip-large-warning" style={{ marginBottom: 8 }}>
            ไฟล์จำนวนมากหรือขนาดใหญ่ (เกิน {LARGE_ZIP_FILES} ไฟล์ หรือ {fmtBytes(LARGE_ZIP_BYTES)}) อาจใช้เวลานาน — ต้องเปิดหน้านี้ค้างไว้จนกว่าจะเสร็จ
          </div>
        )}
        {plan.overCap && (
          <div className="auth-msg err" role="alert" style={{ marginBottom: 0 }}>
            {blobCapMessage(plan.totalBytes, plan.capBytes)}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function RunningPhase({ state, onCancel, onForceClose }) {
  const { progress: p, cancelling } = state
  const [stuck, setStuck] = useState(false)
  // The progress dialog opens exactly where the confirm dialog's "ดาวน์โหลด Zip" button was, with "ยกเลิก" under the
  // pointer: a double click would start the run and cancel it at once. Cancel is armed only after a moment.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 700)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    if (!cancelling) return undefined
    const t = setTimeout(() => setStuck(true), FORCE_CLOSE_AFTER_MS)
    return () => clearTimeout(t)
  }, [cancelling])
  const pct = p.estimate > 0 ? Math.min(99, Math.round((p.bytes / p.estimate) * 100)) : p.total ? Math.round(((p.ok + p.failed) / p.total) * 100) : 0
  const shown = Math.max(1, Math.min(p.total, p.index || 1))
  return (
    <Dialog
      title="กำลังรวมไฟล์เป็น Zip"
      size="sm"
      closable={false}
      footer={
        <>
          {stuck && (
            <button type="button" className="btn btn-danger" onClick={onForceClose} data-testid="zip-force-close">
              ปิดหน้าต่าง
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={cancelling || !armed} data-autofocus data-testid="zip-cancel">
            {cancelling ? 'กำลังยกเลิก...' : 'ยกเลิก'}
          </button>
        </>
      }
    >
      <div className="modal-body" data-testid="zip-running">
        <div aria-live="polite">
          <p style={{ marginBottom: 4 }}>
            <strong>กำลังรวมไฟล์ {p.index ? shown : 0}/{p.total}</strong>
          </p>
          <p className="muted small" style={{ margin: '0 0 10px', overflowWrap: 'anywhere' }} data-testid="zip-current">
            {p.index ? p.name : 'รอเลือกที่บันทึกไฟล์...'}
          </p>
        </div>
        <div
          className="bar zip-bar"
          role="progressbar"
          aria-label="ความคืบหน้าการรวมไฟล์"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          ดาวน์โหลดแล้ว {fmtBytes(p.bytes)} จากประมาณ {fmtBytes(p.estimate)}
          {p.failed > 0 && <> · ข้าม {p.failed} ไฟล์</>}
        </p>
        <p className="muted small" style={{ margin: '8px 0 0' }}>กรุณาอย่าปิดหน้านี้จนกว่าจะเสร็จ</p>
        {stuck && (
          <div className="auth-msg err" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
            การยกเลิกใช้เวลานานผิดปกติ — กด "ปิดหน้าต่าง" เพื่อหยุดและปิดได้ทันที (ไม่มีไฟล์ Zip ถูกบันทึก)
          </div>
        )}
      </div>
    </Dialog>
  )
}

function FailedList({ failed }) {
  if (!failed || failed.length === 0) return null
  return (
    <div style={{ marginTop: 10 }} data-testid="zip-failed">
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>
        ไม่สามารถรวมไฟล์เหล่านี้ได้ ({failed.length}):
      </div>
      <ul className="zip-failed-list">
        {failed.map((f, i) => (
          <li key={`${f.id}-${i}`}>
            <strong>{f.name}</strong>
            <div className="muted small">{f.reason}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FinishedPhase({ state, onClose }) {
  const { result: r, progress } = state
  const total = progress?.total ?? r.ok + r.failed.length
  const footer = (
    <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
      <Icon name="check" size={14} /> ปิด
    </button>
  )
  if (r.status === 'cancelled') {
    return (
      <Dialog title="ยกเลิกแล้ว" size="sm" onClose={onClose} footer={footer}>
        <div className="modal-body" data-testid="zip-cancelled">
          <p>ยกเลิกการรวมไฟล์แล้ว — ไม่ได้บันทึกไฟล์ Zip</p>
          {r.mode === 'disk' && <p className="muted small">หากเบราว์เซอร์สร้างไฟล์ว่างไว้ที่ปลายทาง สามารถลบทิ้งได้</p>}
        </div>
      </Dialog>
    )
  }
  if (r.status === 'failed') {
    return (
      <Dialog title="สร้างไฟล์ Zip ไม่สำเร็จ" size="sm" onClose={onClose} footer={footer}>
        <div className="modal-body" data-testid="zip-error">
          <div className="auth-msg err" role="alert" style={{ marginBottom: 0 }}>
            {r.message}
          </div>
          <FailedList failed={r.failed} />
        </div>
      </Dialog>
    )
  }
  return (
    <Dialog title="รวมไฟล์เสร็จแล้ว" size="sm" onClose={onClose} footer={footer}>
      <div className="modal-body" data-testid="zip-done">
        <p role="status">
          รวมไฟล์สำเร็จ <strong>{r.ok}</strong> จาก {total} ไฟล์ ({fmtBytes(r.bytes)})
          <br />
          <span className="muted small">{r.zipName}</span>
        </p>
        <FailedList failed={r.failed} />
      </div>
    </Dialog>
  )
}
