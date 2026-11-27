import { useState, useRef, useEffect } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { fmtDate, fmtSize, TYPE_LABEL, normalizeFile, computeIsLatest } from '../utils/format.js'
import {
  fetchChatIndex,
  fetchFileContents,
  downloadFile,
  authFetch,
  fetchTrackingOverview,
  fetchInstallments,
} from '../api/supabase.js'
import { searchFiles } from '../utils/aiSearch.js'
import { planGrounding, buildGrounding, localAnswer, portfolioCapNote, stripPassageMarkers } from '../utils/chatRetrieval.js'
import PreviewModal from './PreviewModal.jsx'
import { useZipDownload } from './ZipDownload.jsx'
import { fmtBytes, planZip } from '../utils/zipDownload.js'

// Call backend /api/chat for real Claude AI (if configured)
// The server only needs identifying metadata. Extracted document text (content_text,
// up to 50k chars per file) must NOT be sent: with ~200 files it pushed the request
// past Vercel's 4.5 MB body limit, the call failed with a 413 and the chat silently
// fell back to local search. Uploader names are not needed either (source pills are
// re-mapped from the full context objects on the client).
function slimContext(ctx) {
  return {
    projects: (ctx.projects || []).map((p) => ({ id: p.id, code: p.code, name: p.name })),
    files: (ctx.files || []).map((f) => ({
      id: f.id,
      projectId: f.projectId,
      name: f.name,
      type: f.type,
      size: f.size,
      date: f.date,
      isLatest: f.isLatest,
    })),
  }
}

const API_TIMEOUT_MS = 60000

// `extra` carries the grounding fields (see groundingRequest). Their text is never logged.
// Resolves null when the API is unavailable (error, timeout, fallback signal). A 401 / 403
// account_disabled is also reported app-wide by authFetch (login / "account disabled" screen).
async function callClaudeAPI(query, ctx, history, extra) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
  try {
    const response = await authFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, context: slimContext(ctx), history, ...(extra || {}) }),
      signal: ctrl.signal,
    })
    if (!response.ok) throw new Error(`API not OK (${response.status})`)
    const data = await response.json()
    if (!data || data.reply === '__USE_LOCAL__' || data.fallback) return null
    if (data.intent === 'summary' && !String(data.reply || '').trim()) return null
    return data
  } catch (err) {
    console.warn('Claude API not available, using local search:', err?.name === 'AbortError' ? 'timeout' : err?.message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Request fields for a grounded question: `grounding` (always present when the question was
// a grounding question - {requested:true, empty:true} when nothing could be built), and the
// portfolio / coverage numbers mirrored at the top level of the body.
export function groundingRequest(plan, built) {
  if (!plan?.wants) return {}
  if (!built?.grounding) return { grounding: { requested: true, empty: true } }
  const out = { grounding: built.grounding }
  if (built.projectsTotal != null) {
    out.projectsTotal = built.projectsTotal
    out.projectsShown = built.projectsShown
  }
  if (built.coverage) out.passageCoverage = built.coverage
  return out
}

// Tracking data is cached briefly (10 s) so a burst of questions does not re-read it. A failed
// read is dropped from the cache, but only if it is still THE cached entry (a late failure must
// not clobber a newer, good one).
const TRACKING_TTL_MS = 10000
let overviewEntry = null
const installmentEntries = new Map() // projectId -> { at, promise }
const readFailed = (r) => !r || r.error || !Array.isArray(r.data)

export function clearChatCaches() {
  overviewEntry = null
  installmentEntries.clear()
}

function getOverviewCached() {
  if (overviewEntry && Date.now() - overviewEntry.at < TRACKING_TTL_MS) return overviewEntry.promise
  const entry = { at: Date.now(), promise: null }
  entry.promise = Promise.resolve()
    .then(() => fetchTrackingOverview())
    .catch((error) => ({ data: null, error }))
  overviewEntry = entry
  entry.promise.then((r) => {
    if (readFailed(r) && overviewEntry === entry) overviewEntry = null
  })
  return entry.promise
}

function getInstallmentsCached(projectId) {
  const hit = installmentEntries.get(projectId)
  if (hit && Date.now() - hit.at < TRACKING_TTL_MS) return hit.promise
  const entry = { at: Date.now(), promise: null }
  entry.promise = Promise.resolve()
    .then(() => fetchInstallments(projectId))
    .catch((error) => ({ data: null, error }))
  installmentEntries.set(projectId, entry)
  entry.promise.then((r) => {
    if (readFailed(r) && installmentEntries.get(projectId) === entry) installmentEntries.delete(projectId)
  })
  return entry.promise
}

const CAPTION = 'สรุปโดย AI จากเอกสารและข้อมูลเบิกงวดงานในระบบ — ตรวจสอบกับเอกสารต้นฉบับก่อนใช้งานจริง'
const NOTE_LATEST = '“ล่าสุด” ดูจากวันที่อัปโหลดไฟล์ ไม่ใช่วันที่ในเอกสาร'
const NOTE_MEETINGS_BY_UPLOAD = 'ชุดนี้เรียงตามวันที่อัปโหลด เพราะชื่อไฟล์ไม่มีเลขครั้ง/วันที่'
const NOTE_TRUNCATED = 'คำตอบถูกตัดเพราะยาวเกินไป ลองถามให้เจาะจงขึ้น'
const NOTE_AI_DOWN_FILES = 'ขณะนี้ AI สรุปไม่ได้ — แสดงผลค้นหาไฟล์แทน'
const NOTE_AI_DOWN_TRACKING = 'ขณะนี้ AI สรุปไม่ได้ — แสดงข้อมูลเบิกงวดงานจากระบบแทน'
const WAIT_CONTENT_MS = 20000

const welcomeText = (exampleProject) =>
  [
    'สวัสดีครับ ผมเป็น AI Document Agent ช่วยค้นหาเอกสาร, ดาวน์โหลดไฟล์, ตอบคำถามเกี่ยวกับโครงการของคุณ หรือตรวจสอบความครบถ้วนของเอกสารขออนุญาตก่อสร้างได้ครับ',
    '',
    'ลองถามได้หลากหลายแบบ:',
    '• "หา EIA ล่าสุดของ MRT-PP"',
    '• "ไฟล์ที่อัพโหลดเมื่อวาน"',
    '• "เอกสารใหญ่กว่า 5MB"',
    '• "มีโครงการอะไรบ้าง"',
    '• "ช่วยตรวจสอบเอกสารขออนุญาตก่อสร้างให้หน่อย"',
    '',
    'สรุปและถามเนื้อหาเอกสารได้ด้วย:',
    `• "${exampleProject ? `สรุปเรื่องราวโครงการ ${exampleProject}` : 'สรุปเรื่องราวโครงการ …'}"`,
    '• "ประชุมครั้งล่าสุดคุยเรื่องอะไร"',
    '• "โครงการไหนเอกสารเบิกยังขาด"',
  ].join('\n')

const listNames = (items) => items.slice(0, 3).map((x) => x.fileName).join(', ') + (items.length > 3 ? ` และอีก ${items.length - 3} ไฟล์` : '')
const projectLabel = (p) => [p.code, p.name].filter(Boolean).join(' ')

// The chat hands out at most PICK_MAX files per answer (pickable: preview / download / zip). A file list with
// more matches is shown as names grouped by project + advice to download from the project page, with a button
// that opens each project (decided with the user).
export const PICK_MAX = 8
const isOverflow = (m) => m.intent === 'list' && Array.isArray(m.files) && m.files.length > 0 && Math.max(m.matchCount || 0, m.files.length) > PICK_MAX
const OVERFLOW_PROJECT_BUTTONS = 6

function ListOverflow({ m, projects, onOpenProject, onPreview }) {
  const total = Math.max(m.matchCount || 0, m.files.length)
  const byProject = new Map()
  for (const f of m.files) {
    const k = f.projectId || ''
    if (!byProject.has(k)) byProject.set(k, [])
    byProject.get(k).push(f)
  }
  const pmap = new Map((projects || []).map((p) => [p.id, p]))
  const groups = [...byProject.entries()].map(([pid, files]) => ({ pid, project: pmap.get(pid) || null, files }))
  const label = (p) => (p ? (p.code ? `${p.code}` : p.name) : 'ไม่ทราบโครงการ')
  return (
    <div className="chat-overflow" data-testid="chat-overflow">
      <div className="chat-overflow-tip">
        พบ <b>{total.toLocaleString()} ไฟล์</b> — เกินกว่าที่ AI หยิบให้ได้ครั้งละ {PICK_MAX} ไฟล์
        <br />
        แนะนำให้เข้าไปดาวน์โหลดที่หน้าโครงการโดยตรง (ติ๊กเลือกหลายไฟล์แล้วกด "ดาวน์โหลด Zip" ได้)
      </div>
      {onOpenProject && (
        <div className="chat-overflow-btns">
          {groups
            .filter((g) => g.project)
            .slice(0, OVERFLOW_PROJECT_BUTTONS)
            .map((g) => (
              <button
                key={g.pid}
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onOpenProject(g.pid)}
                title={g.project.name}
                data-testid="chat-open-project"
              >
                <Icon name="folder" size={13} /> เปิดโครงการ {label(g.project)}{total === m.files.length ? ` (${g.files.length})` : ''}
              </button>
            ))}
        </div>
      )}
      <div className="chat-overflow-list">
        {groups.map((g) => (
          <div key={g.pid || 'none'} className="chat-overflow-group">
            <div className="chat-overflow-proj">
              {label(g.project)}
              {g.project?.name && g.project.code ? <span className="muted"> — {g.project.name}</span> : null}
            </div>
            <ol>
              {g.files.map((f) => (
                <li key={f.id}>
                  <button type="button" className="chat-overflow-file" onClick={() => onPreview(f)} title="ดูตัวอย่าง">
                    {f.name}
                  </button>
                  <span className="muted"> · {TYPE_LABEL[f.type] || f.type} · {fmtDate(f.date)}{f.isLatest ? ' · ล่าสุด' : ''}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
        {total > m.files.length && (
          <div className="muted small">แสดงรายชื่อ {m.files.length} จาก {total.toLocaleString()} ไฟล์ — ดูทั้งหมดได้ที่หน้าโครงการ</div>
        )}
      </div>
    </div>
  )
}

export default function AIChat({ open, onClose, onOpenProject }) {
  const [msgs, setMsgs] = useState([{ role: 'bot', welcome: true, text: '' }])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ctx, setCtx] = useState({ projects: [], files: [] })
  const [ctxReady, setCtxReady] = useState(false)
  const ctxTask = useRef(null)
  const ctxRef = useRef({ projects: [], files: [] }) // always the latest (state is stale inside send())
  const contentTask = useRef(Promise.resolve(true)) // resolves (never rejects) when extracted text has finished loading
  // 'pending' (still loading) | 'ready' (complete) | 'partial' (the read stopped on an error)
  const contentState = useRef('pending')
  const [thinkingStatus, setThinkingStatus] = useState('')
  const [aiMode, setAiMode] = useState('local') // 'local' or 'claude'
  const [previewFile, setPreviewFile] = useState(null)
  const endRef = useRef(null)
  const toast = useToast()
  const zip = useZipDownload()
  // per answer (message index): ids of listed files the person UNticked. Default = everything listed is selected.
  const [skipped, setSkipped] = useState({})

  useEffect(() => {
    if (!open) return
    clearChatCaches()
    loadContext()
  }, [open])

  useEffect(() => {
    endRef.current?.scrollTo(0, 99999)
  }, [msgs, thinking])

  // Context loads in two steps: fast metadata (needed before the first question is
  // answered) and extracted text in the background (the local content search and the
  // grounded summaries use it). send() waits for step 1 — asking before it finished used
  // to give the AI an empty library and a confident "no projects / no files" answer.
  const commitCtx = (next) => {
    ctxRef.current = next
    setCtx(next)
  }

  const loadContext = () => {
    const task = (async () => {
      const { projects, files } = await fetchChatIndex()
      const allFiles = files.map((r) => normalizeFile(r))
      computeIsLatest(allFiles)
      // keep text we already loaded earlier (reopening the panel must not drop it)
      const prevText = new Map(ctxRef.current.files.filter((f) => f.contentText).map((f) => [f.id, f.contentText]))
      for (const f of allFiles) if (!f.contentText && prevText.has(f.id)) f.contentText = prevText.get(f.id)
      commitCtx({ projects, files: allFiles })
      setCtxReady(true)
      contentState.current = 'pending'
      let failed = false
      contentTask.current = fetchFileContents({ onError: () => (failed = true) })
        .then((contents) => {
          const cur = ctxRef.current
          commitCtx({ ...cur, files: cur.files.map((f) => (contents[f.id] ? { ...f, contentText: contents[f.id] } : f)) })
          contentState.current = failed ? 'partial' : 'ready'
          return !failed
        })
        .catch(() => {
          contentState.current = 'partial'
          return false
        })
      return { projects, files: allFiles }
    })()
    ctxTask.current = task
    task.catch((err) => {
      console.error('load ctx:', err)
      setCtxReady(false)
    })
    return task
  }

  const exampleProject = (() => {
    const p = ctx.projects.find((x) => x.name || x.code)
    if (!p) return ''
    return p.name && p.name.length <= 40 ? p.name : p.code || p.name.slice(0, 40)
  })()

  const suggestions = [
    'หาไฟล์ล่าสุดทั้งหมด',
    'ไฟล์ที่อัพโหลดเมื่อวาน',
    'มีโครงการอะไรบ้าง',
    'BOQ ล่าสุดของทุกโครงการ',
    ...(exampleProject ? [`สรุปเรื่องราวโครงการ ${exampleProject}`] : []),
    'ประชุมครั้งล่าสุดคุยเรื่องอะไร',
    'โครงการไหนเอกสารเบิกยังขาด',
  ]

  const pushBot = (msg) => setMsgs((m) => [...m, { role: 'bot', ...msg }])

  const send = async (textOverride) => {
    const text = (textOverride ?? input).trim()
    if (!text || thinking) return
    setInput('')
    setMsgs((m) => [...m, { role: 'user', text }])
    setThinkingStatus('')
    setThinking(true)

    try {
      // Try Claude API first (if configured) — send recent turns so multi-step
      // conversations (e.g. the permit document checklist) keep context
      // [Ref n] numbers are assigned per answer: old ones must not leak into the next request (they would mean other files)
      const history = msgs.filter((m) => !m.welcome).slice(-12).map((m) => ({ role: m.role, text: String(m.text ?? '').replace(/\s?\[Ref \d{1,3}\]/g, '') }))
      const lastBot = [...msgs].reverse().find((m) => m.role === 'bot' && !m.welcome)
      if (!ctxReady) {
        try {
          // (re)start loading if it never ran or failed, then wait for the metadata
          await Promise.race([
            (ctxTask.current || loadContext()).catch(() => loadContext()),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
          ])
        } catch (err) {
          pushBot({ text: 'โหลดข้อมูลโครงการไม่สำเร็จ ลองใหม่อีกครั้งในอีกสักครู่ครับ' })
          return
        }
      }

      // Summary / content / status questions: build grounding (project briefs + document
      // passages) on the client. A failure here means "nothing could be built", which is still
      // reported to the server (grounding {requested, empty}) so it does not answer from thin air.
      let plan = null
      let built = null
      try {
        plan = planGrounding(text, history, ctxRef.current.projects, { prevProjectIds: lastBot?.projectIds || [] })
        if (plan.needsProject) {
          // no project named or inferable: ask, instead of guessing
          await new Promise((r) => setTimeout(r, 250))
          pushBot({ text: localAnswer(text, plan, null, ctxRef.current), intent: 'answer', usedAI: 'local', files: [] })
          return
        }
        if (plan.wants) {
          if (plan.needsContent && contentState.current === 'pending') {
            setThinkingStatus('กำลังเตรียมเนื้อหาเอกสาร…')
            await Promise.race([contentTask.current, new Promise((r) => setTimeout(r, WAIT_CONTENT_MS))])
          }
          setThinkingStatus('กำลังอ่านเอกสารและสรุป…')
          built = await buildGrounding(plan, text, ctxRef.current, {
            getOverview: getOverviewCached,
            getInstallments: getInstallmentsCached,
            contentState: contentState.current === 'ready' ? 'ready' : contentState.current,
          })
        }
      } catch (err) {
        console.warn('grounding unavailable:', err?.message)
        built = null
      }
      const grounded = !!plan?.wants

      const liveCtx = ctxRef.current
      let result = await callClaudeAPI(text, liveCtx, history, groundingRequest(plan, built))
      let usedAI = 'local'
      const notes = []

      let localTrackingAnswer = false
      if (!result) {
        // Fallback to local rule-based search; tracking questions get a deterministic answer
        const local = grounded ? localAnswer(text, plan, built, liveCtx) : null
        if (local) {
          result = { intent: 'answer', reply: local }
          localTrackingAnswer = true
          if (!built?.trackingFailed) notes.push(NOTE_AI_DOWN_TRACKING)
        } else {
          result = searchFiles(text, liveCtx)
          if (grounded) notes.push(NOTE_AI_DOWN_FILES)
        }
      } else {
        usedAI = 'claude'
        const cap = portfolioCapNote(built?.projectsShown, built?.projectsTotal)
        if (cap) notes.push(cap)
        if (result.truncated === true) notes.push(NOTE_TRUNCATED)
      }
      const isSummary = result.intent === 'summary'
      if (isSummary && usedAI === 'claude') {
        const cov = built?.coverage
        if (cov?.partial && cov.filesSelected > 0) notes.push(`อ่านเนื้อหา ${cov.filesRead} จาก ${cov.filesSelected} ไฟล์ (เฉพาะส่วนต้นของเอกสาร)`)
        const passages = built?.grounding?.passages || []
        if (passages.length) {
          // meeting minutes are ordered by meeting number / date per series, so "ล่าสุด = upload date" is false for THEM;
          // it still holds for every other kind of source (contract, TOR, ...): say it whenever one of those is a source
          const meetings = Array.isArray(built.meetings) ? built.meetings : Array.isArray(built.grounding.meetings) ? built.grounding.meetings : []
          if (passages.some((ps) => ps && !ps.series)) notes.push(NOTE_LATEST)
          if (meetings.some((m) => m && m.orderedByUpload === true)) notes.push(NOTE_MEETINGS_BY_UPLOAD)
        }
      }

      // The server only knows the slim context: map source files back to the full objects
      // (storagePath / ext are needed for preview and download). Null / id-less entries are dropped.
      let files = Array.isArray(result.files) ? result.files.filter((f) => f && typeof f === 'object' && f.id != null) : []
      if (files.length) {
        const byId = new Map(liveCtx.files.map((f) => [String(f.id), f]))
        files = files.map((f) => {
          const full = byId.get(String(f.id))
          const { contentText: _drop, ...slim } = f
          if (!full) return slim
          const { contentText, ...rest } = full
          return { ...rest, ...slim, storagePath: slim.storagePath || rest.storagePath, ext: slim.ext || rest.ext }
        })
      }

      // References under the answer: "Ref n" = a file whose text was sent (numbered by the server, the model cites
      // "[Ref n]"), plus "ระบบเบิกงวดงาน" when tracking data was used. Only ids of the local index are shown as files.
      let refs = []
      if (usedAI === 'claude' && Array.isArray(result.refs)) {
        const byId = new Map(liveCtx.files.map((f) => [String(f.id), f]))
        const seenRef = new Set()
        for (const r of result.refs) {
          const n = r && Number.isInteger(r.ref) && r.ref >= 1 && r.ref <= 99 ? r.ref : null
          if (!n || seenRef.has(n)) continue
          seenRef.add(n)
          const full = r.fileId != null ? byId.get(String(r.fileId)) : null
          if (full) {
            const { contentText, _snippet, ...rest } = full
            refs.push({ ...rest, refNo: n })
          } else {
            refs.push({ refNo: n, name: String(r.fileName || 'ไฟล์ที่ไม่พบในรายการ'), missing: true })
          }
        }
        refs.sort((a, b) => a.refNo - b.refNo)
        const cited = new Set([...String(result.reply ?? '').matchAll(/\[Ref (\d{1,3})\]/g)].map((x) => Number(x[1])))
        if (cited.size) refs = refs.filter((f) => cited.has(f.refNo))
      }
      const usedTracking = usedAI === 'claude'
        ? result.trackingRef === true
        : localTrackingAnswer && !!built?.grounding?.projectBriefs?.length && !built?.trackingFailed
      // grounded answer with references: the reference files ARE the file list (Ref order), so preview / zip cover them
      if (refs.some((f) => !f.missing) && result.intent !== 'list' && result.intent !== 'download_zip') files = refs.filter((f) => !f.missing)

      // Ensure minimum thinking time for natural feel
      await new Promise((r) => setTimeout(r, 400))

      setAiMode(usedAI)
      const replyText = String(result.reply ?? '')
      pushBot({
        // [P1]-style passage markers are for the model only: never show them on a grounded question
        text: grounded ? stripPassageMarkers(replyText) : replyText,
        intent: result.intent,
        fileName: result.fileName,
        projectCode: result.projectCode,
        fileId: result.fileId,
        files,
        matchCount: Number.isInteger(result.matchCount) ? result.matchCount : null,
        refs,
        refsMissing: refs.filter((f) => f.missing),
        trackingRef: usedTracking,
        usedAI,
        // which project(s) this answer was about (follow-up questions inherit them), and whether we inherited them
        // (portfolio answers are about no single project, so nothing is inherited from them)
        projectIds: plan?.projects?.map((p) => p.id) || [],
        inheritedProjects: plan?.inherited ? plan.projects.map(projectLabel) : [],
        // what the client could not read, taken from the data it sent (not from the model)
        notIndexed: isSummary ? built?.notIndexed || [] : [],
        notLoaded: isSummary ? built?.notLoaded || [] : [],
        truncated: isSummary ? built?.truncated || [] : [],
        notes,
      })
    } catch (err) {
      console.error('chat send failed:', err?.message)
      pushBot({ text: 'เกิดข้อผิดพลาดระหว่างตอบคำถาม ลองใหม่อีกครั้งครับ' })
    } finally {
      setThinking(false)
      setThinkingStatus('')
    }
  }

  const triggerDownload = async (fileId, fileName) => {
    try {
      await downloadFile(fileId, fileName)
      toast(`ดาวน์โหลด ${fileName}`)
    } catch (err) {
      toast(err?.message || 'ดาวน์โหลดไม่สำเร็จ', 'err')
    }
  }

  // "ดาวน์โหลด Zip: <project>" -> the latest version of every document of that project, read fresh and complete
  // (paged, so a big project is not silently cut), after a confirm dialog with the true count and size.
  const triggerZip = (projectCode) => {
    const code = String(projectCode || '').trim().toLowerCase()
    const { projects } = ctxRef.current
    const project = projects.find((p) => String(p.code || '').trim().toLowerCase() === code) || projects.find((p) => String(p.name || '').trim().toLowerCase() === code)
    if (!project) {
      toast(`ไม่พบโครงการ ${projectCode} ในรายการที่คุณเข้าถึงได้`, 'err')
      return
    }
    zip.beginProject(project)
  }

  const toggleListed = (msgIndex, id) =>
    setSkipped((prev) => {
      const cur = new Set(prev[msgIndex] || [])
      const key = String(id)
      if (cur.has(key)) cur.delete(key)
      else cur.add(key)
      return { ...prev, [msgIndex]: cur }
    })
  const setAllListed = (msgIndex, files, selectAll) =>
    setSkipped((prev) => ({ ...prev, [msgIndex]: selectAll ? new Set() : new Set(files.map((f) => String(f.id))) }))

  // The ticked files of one answer -> one zip. The answer (possibly from the server) only NAMES files: each id must exist in
  // OUR index of what this person may see, and name / size / project / date are taken from that local row, never from
  // the answer. Anything else is dropped and the person is told how many.
  const zipListed = (msgIndex, files) => {
    const { projects, files: index } = ctxRef.current
    const byId = new Map(index.map((f) => [String(f.id), f]))
    const ticked = files.filter((f) => !skipped[msgIndex]?.has(String(f.id)))
    const chosen = []
    for (const f of ticked) {
      const local = byId.get(String(f.id))
      if (local) chosen.push({ id: local.id, name: local.name, size: local.size, projectId: local.projectId, date: local.date, ext: local.ext, type: local.type })
    }
    const dropped = ticked.length - chosen.length
    if (dropped > 0) toast(`ข้าม ${dropped} ไฟล์ที่ไม่อยู่ในรายการเอกสารของคุณ`, 'err')
    if (chosen.length === 0) return
    const projectIds = new Set(chosen.map((f) => f.projectId))
    const only = projectIds.size === 1 ? projects.find((p) => p.id === [...projectIds][0]) : null
    zip.begin({ files: chosen, projectCode: only?.code || null, scope: 'ไฟล์ที่เลือก', confirm: false })
  }

  // Render markdown-lite (bold + line breaks)
  const renderText = (text, refs) => {
    if (!text) return null
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    const byRef = new Map((refs || []).map((f) => [f.refNo, f]))
    const withRefs = (str, key) =>
      str.split(/(\[Ref \d{1,3}\])/g).map((seg, j) => {
        const m = /^\[Ref (\d{1,3})\]$/.exec(seg)
        if (!m) return seg
        const f = byRef.get(Number(m[1]))
        if (!f) return seg
        return f.missing ? (
          <span key={`${key}-${j}`} className="ref-chip" title={f.name}>Ref {f.refNo}</span>
        ) : (
          <button key={`${key}-${j}`} type="button" className="ref-chip" title={`เปิด ${f.name}`} onClick={() => setPreviewFile(f)}>
            Ref {f.refNo}
          </button>
        )
      })
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={i} style={{ color: 'var(--navy)' }}>
            {withRefs(part.slice(2, -2), i)}
          </strong>
        )
      }
      return <span key={i}>{withRefs(part, i)}</span>
    })
  }

  // closed panel: a zip that is still running keeps its progress dialog (it has the Cancel button)
  if (!open) return zip.dialog

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <div className="ico">
          <Icon name="sparkles" size={18} />
        </div>
        <div>
          <div className="ttl">ถามหาเอกสาร</div>
          <div className="sub">
            {aiMode === 'claude' ? 'Claude Haiku 4.5 · พร้อมตอบเสมอ' : 'Smart Search · พร้อมตอบเสมอ'}
          </div>
        </div>
        <button className="close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="chat-msgs" ref={endRef}>
        {msgs.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <div className="bubble">
              <div style={{ whiteSpace: 'pre-line' }}>{renderText(m.welcome ? welcomeText(exampleProject) : m.intent === 'summary' ? stripPassageMarkers(m.text) : m.text, m.refs)}</div>
              {(m.trackingRef || (m.refs && m.refs.length > 0) || (m.intent === 'summary' && m.files && m.files.length > 0)) && (
                <div className="chat-refs-h" data-testid="chat-refs">
                  <div>{m.refs && m.refs.length > 0 ? 'อ้างอิง (Ref)' : m.trackingRef ? 'อ้างอิง' : 'แหล่งข้อมูล'}</div>
                  {m.trackingRef && (
                    <div className="chat-ref-sys" data-testid="chat-ref-tracking">
                      <span className="ref-chip ref-chip-sys">ระบบ</span> ข้อมูลในหน้าเบิกงวดงาน (ความคืบหน้า / งวดเบิก / เอกสารประกอบการเบิก)
                    </div>
                  )}
                  {(m.refsMissing || []).map((f) => (
                    <div key={`miss-${f.refNo}`} className="chat-ref-sys">
                      <span className="ref-chip">Ref {f.refNo}</span> {f.name} (ไม่พบในรายการไฟล์ที่คุณเข้าถึงได้ตอนนี้)
                    </div>
                  ))}
                </div>
              )}
              {isOverflow(m) && (
                <ListOverflow
                  m={m}
                  projects={ctx.projects}
                  onPreview={setPreviewFile}
                  onOpenProject={
                    onOpenProject
                      ? async (pid) => {
                          const ok = await onOpenProject(pid)
                          if (ok) onClose?.()
                          else toast('เปิดโครงการไม่สำเร็จ — อาจไม่มีสิทธิ์เข้าถึงโครงการนี้แล้ว หรือการเชื่อมต่อขัดข้อง', 'err')
                        }
                      : null
                  }
                />
              )}
              {(m.intent === 'list' || m.intent === 'summary' || (m.refs && m.refs.length > 0)) && m.files && m.files.length > 0 && !isOverflow(m) && (
                <div style={{ marginTop: m.intent === 'list' ? 8 : 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {m.files.length >= 2 && (() => {
                    const chosen = m.files.filter((f) => !skipped[i]?.has(String(f.id)))
                    const plan = planZip(chosen)
                    return (
                      <div className="zip-sel" data-testid="chat-zip-sel">
                        <span aria-live="polite">
                          เลือก {plan.count} จาก {m.files.length} ไฟล์ <span style={{ color: 'var(--gray-500)' }}>({fmtBytes(plan.totalBytes)})</span>
                        </span>
                        <span className="zip-sel-links">
                          <button type="button" onClick={() => setAllListed(i, m.files, true)} disabled={plan.count === m.files.length}>เลือกทั้งหมด</button>
                          <button type="button" onClick={() => setAllListed(i, m.files, false)} disabled={plan.count === 0}>ล้างที่เลือก</button>
                        </span>
                      </div>
                    )
                  })()}
                  {m.files.map((f) => (
                    <div
                      key={f.id}
                      className="file-pill"
                      style={{ marginTop: 0, flexDirection: 'column', alignItems: 'stretch', cursor: 'default' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {m.files.length >= 2 && (
                          <input
                            type="checkbox"
                            className="pill-check"
                            checked={!skipped[i]?.has(String(f.id))}
                            onChange={() => toggleListed(i, f.id)}
                            aria-label={`เลือกไฟล์ ${f.name}`}
                            data-testid="chat-file-check"
                          />
                        )}
                        <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => setPreviewFile(f)}>
                          <div
                            className="nm"
                            style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          >
                            {f.refNo ? <span className="ref-chip" data-testid="chat-ref-no">Ref {f.refNo}</span> : null}
                            {f.name}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--gray-500)' }}>
                            {TYPE_LABEL[f.type] || f.type} · {fmtSize(f.size)} · {fmtDate(f.date)}
                            {f.isLatest && ' · ล่าสุด'}
                            {f.uploader && ` · ${f.uploader}`}
                          </div>
                        </div>
                        <button
                          className="icon-btn"
                          onClick={() => setPreviewFile(f)}
                          title="ดูตัวอย่าง"
                          style={{ width: 26, height: 26 }}
                        >
                          <Icon name="eye" size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => triggerDownload(f.id, f.name)}
                          title="ดาวน์โหลด"
                          style={{ width: 26, height: 26, color: 'var(--green)' }}
                        >
                          <Icon name="download" size={13} />
                        </button>
                      </div>
                      {f._snippet && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '6px 8px',
                            background: 'rgba(45,190,96,0.08)',
                            borderLeft: '3px solid var(--green)',
                            borderRadius: 4,
                            fontSize: 11,
                            color: 'var(--gray-700)',
                            fontStyle: 'italic',
                            lineHeight: 1.4,
                          }}
                        >
                          📄 {f._snippet}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {(m.intent === 'list' || m.intent === 'summary' || (m.refs && m.refs.length > 0)) && m.files && m.files.length >= 2 && !isOverflow(m) && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  style={{ marginTop: 10 }}
                  onClick={() => zipListed(i, m.files)}
                  disabled={zip.busy || m.files.every((f) => skipped[i]?.has(String(f.id)))}
                  data-testid="chat-zip-selected"
                >
                  <Icon name="zip" size={13} /> ดาวน์โหลดที่เลือกเป็น Zip
                </button>
              )}
              {(m.intent === 'summary' || (m.notes && m.notes.length > 0)) && (
                <div className="chat-grounding-note" style={{ marginTop: 8, fontSize: 10, color: 'var(--gray-500)', lineHeight: 1.5 }}>
                  {m.intent === 'summary' && <div>{CAPTION}</div>}
                  {m.intent === 'summary' && m.inheritedProjects && m.inheritedProjects.length > 0 && (
                    <div>โครงการ: {m.inheritedProjects.join(', ')} (ต่อจากคำถามก่อนหน้า)</div>
                  )}
                  {m.notIndexed && m.notIndexed.length > 0 && <div>ยังอ่านเนื้อหาไม่ได้: {listNames(m.notIndexed)}</div>}
                  {m.notLoaded && m.notLoaded.length > 0 && <div>ยังโหลดเนื้อหาไม่เสร็จ: {listNames(m.notLoaded)}</div>}
                  {m.truncated && m.truncated.length > 0 && <div>อ่านได้เฉพาะ 50,000 ตัวอักษรแรก: {listNames(m.truncated)}</div>}
                  {(m.notes || []).map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </div>
              )}
              {m.intent === 'download_single' && m.fileId && (
                <div className="file-pill" onClick={() => triggerDownload(m.fileId, m.fileName)}>
                  <Icon name="download" size={14} style={{ color: 'var(--green)' }} />
                  <span className="nm">ดาวน์โหลด: {m.fileName}</span>
                </div>
              )}
              {m.intent === 'download_zip' && m.projectCode && (
                <div
                  className="file-pill"
                  role="button"
                  tabIndex={0}
                  onClick={() => triggerZip(m.projectCode)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      triggerZip(m.projectCode)
                    }
                  }}
                  data-testid="chat-zip-project"
                >
                  <Icon name="zip" size={14} style={{ color: 'var(--green)' }} />
                  <span className="nm">ดาวน์โหลด Zip: {m.projectCode}</span>
                </div>
              )}
            </div>
            {m.role === 'bot' && m.usedAI === 'claude' && (
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--gray-400)',
                  marginTop: 4,
                  marginLeft: 4,
                  letterSpacing: '0.04em',
                }}
              >
                ⚡ Claude AI
              </div>
            )}
          </div>
        ))}
        {thinking && (
          <div className="msg bot">
            <div className="bubble">
              <div className="typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
              {thinkingStatus && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--gray-500)' }}>{thinkingStatus}</div>
              )}
            </div>
          </div>
        )}
        {msgs.length === 1 && !thinking && (
          <div className="chat-suggest">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="chat-input">
        <input
          placeholder="พิมพ์คำถาม เช่น หา BOQ ล่าสุดของ ABC..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button onClick={() => send()} disabled={thinking || !input.trim()}>
          <Icon name="send" size={16} />
        </button>
      </div>

      {previewFile && (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {zip.dialog}
    </div>
  )
}

export function ChatFab({ onClick }) {
  return (
    <button className="chat-fab" onClick={onClick} title="ถามหาเอกสาร">
      <Icon name="sparkles" size={22} />
    </button>
  )
}
