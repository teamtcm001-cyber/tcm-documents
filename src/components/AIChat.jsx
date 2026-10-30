import { useState, useRef, useEffect } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { fmtDate, fmtSize, TYPE_LABEL, normalizeFile, computeIsLatest } from '../utils/format.js'
import {
  fetchChatIndex,
  fetchFileContents,
  downloadFile,
  fetchTrackingOverview,
  fetchInstallments,
} from '../api/supabase.js'
import { searchFiles } from '../utils/aiSearch.js'
import { planGrounding, buildGrounding, localAnswer, portfolioCapNote, stripPassageMarkers } from '../utils/chatRetrieval.js'
import PreviewModal from './PreviewModal.jsx'

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
// Resolves null when the API is unavailable (error, 401, timeout, fallback signal).
async function callClaudeAPI(query, ctx, history, extra) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch('/api/chat', {
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

const CAPTION = 'สรุปโดย AI จากเอกสารและข้อมูลติดตามงานในระบบ — ตรวจสอบกับเอกสารต้นฉบับก่อนใช้งานจริง'
const NOTE_LATEST = '“ล่าสุด” ดูจากวันที่อัปโหลดไฟล์ ไม่ใช่วันที่ในเอกสาร'
const NOTE_TRUNCATED = 'คำตอบถูกตัดเพราะยาวเกินไป ลองถามให้เจาะจงขึ้น'
const NOTE_AI_DOWN_FILES = 'ขณะนี้ AI สรุปไม่ได้ — แสดงผลค้นหาไฟล์แทน'
const NOTE_AI_DOWN_TRACKING = 'ขณะนี้ AI สรุปไม่ได้ — แสดงข้อมูลติดตามงานจากระบบแทน'
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

export default function AIChat({ open, onClose }) {
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
      const history = msgs.filter((m) => !m.welcome).slice(-12).map((m) => ({ role: m.role, text: m.text }))
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

      if (!result) {
        // Fallback to local rule-based search; tracking questions get a deterministic answer
        const local = grounded ? localAnswer(text, plan, built, liveCtx) : null
        if (local) {
          result = { intent: 'answer', reply: local }
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
        if (built?.grounding?.passages?.length) notes.push(NOTE_LATEST)
      }

      // The server only knows the slim context: map source files back to the full objects
      // (storagePath / ext are needed for preview and download). Null / id-less entries are dropped.
      let files = Array.isArray(result.files) ? result.files.filter((f) => f && typeof f === 'object' && f.id != null) : []
      if (files.length) {
        const byId = new Map(liveCtx.files.map((f) => [String(f.id), f]))
        files = files.map((f) => {
          const full = byId.get(String(f.id))
          if (!full) return f
          const { contentText, ...rest } = full
          return { ...rest, ...f, storagePath: f.storagePath || rest.storagePath, ext: f.ext || rest.ext }
        })
      }

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
      toast('ดาวน์โหลดไม่สำเร็จ', 'err')
    }
  }

  const triggerZip = (projectCode) => {
    toast(`Zip โครงการ ${projectCode} ยังไม่รองรับ`, 'err')
  }

  // Render markdown-lite (bold + line breaks)
  const renderText = (text) => {
    if (!text) return null
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={i} style={{ color: 'var(--navy)' }}>
            {part.slice(2, -2)}
          </strong>
        )
      }
      return <span key={i}>{part}</span>
    })
  }

  if (!open) return null

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
              <div style={{ whiteSpace: 'pre-line' }}>{renderText(m.welcome ? welcomeText(exampleProject) : m.intent === 'summary' ? stripPassageMarkers(m.text) : m.text)}</div>
              {m.intent === 'summary' && m.files && m.files.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 10, color: 'var(--gray-500)' }}>แหล่งข้อมูล</div>
              )}
              {(m.intent === 'list' || m.intent === 'summary') && m.files && m.files.length > 0 && (
                <div style={{ marginTop: m.intent === 'summary' ? 4 : 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {m.files.map((f) => (
                    <div
                      key={f.id}
                      className="file-pill"
                      style={{ marginTop: 0, flexDirection: 'column', alignItems: 'stretch', cursor: 'default' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => setPreviewFile(f)}>
                          <div
                            className="nm"
                            style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          >
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
                <div className="file-pill" onClick={() => triggerZip(m.projectCode)}>
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
