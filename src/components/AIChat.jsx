import { useState, useRef, useEffect } from 'react'
import Icon from './Icon.jsx'
import { useToast } from './Toast.jsx'
import { fmtDate, fmtSize, TYPE_LABEL, normalizeFile, computeIsLatest } from '../utils/format.js'
import { fetchProjects, fetchFiles, downloadFile } from '../api/supabase.js'
import { searchFiles } from '../utils/aiSearch.js'
import PreviewModal from './PreviewModal.jsx'

// Call backend /api/chat for real Claude AI (if configured)
async function callClaudeAPI(query, ctx, history) {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, context: ctx, history }),
    })
    if (!response.ok) throw new Error('API not OK')
    const data = await response.json()
    if (data.reply === '__USE_LOCAL__' || data.fallback) return null
    return data
  } catch (err) {
    console.warn('Claude API not available, using local search:', err.message)
    return null
  }
}

export default function AIChat({ open, onClose }) {
  const [msgs, setMsgs] = useState([
    {
      role: 'bot',
      text:
        'สวัสดีครับ ผมเป็น AI Document Agent ช่วยค้นหาเอกสาร, ดาวน์โหลดไฟล์, ตอบคำถามเกี่ยวกับโครงการของคุณ หรือตรวจสอบความครบถ้วนของเอกสารขออนุญาตก่อสร้างได้ครับ\n\nลองถามได้หลากหลายแบบ:\n• "หา EIA ล่าสุดของ MRT-PP"\n• "ไฟล์ที่อัพโหลดเมื่อวาน"\n• "เอกสารใหญ่กว่า 5MB"\n• "มีโครงการอะไรบ้าง"\n• "ช่วยตรวจสอบเอกสารขออนุญาตก่อสร้างให้หน่อย"',
    },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ctx, setCtx] = useState({ projects: [], files: [] })
  const [aiMode, setAiMode] = useState('local') // 'local' or 'claude'
  const [previewFile, setPreviewFile] = useState(null)
  const endRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    loadContext()
  }, [open])

  useEffect(() => {
    endRef.current?.scrollTo(0, 99999)
  }, [msgs, thinking])

  const loadContext = async () => {
    try {
      const projects = await fetchProjects()
      const allFiles = []
      for (const p of projects) {
        const rows = await fetchFiles(p.id)
        rows.forEach((r) => allFiles.push(normalizeFile(r)))
      }
      computeIsLatest(allFiles)
      setCtx({ projects, files: allFiles })
    } catch (err) {
      console.error('load ctx:', err)
    }
  }

  const suggestions = [
    'หาไฟล์ล่าสุดทั้งหมด',
    'ไฟล์ที่อัพโหลดเมื่อวาน',
    'มีโครงการอะไรบ้าง',
    'BOQ ล่าสุดของทุกโครงการ',
  ]

  const send = async (textOverride) => {
    const text = (textOverride ?? input).trim()
    if (!text || thinking) return
    setInput('')
    setMsgs((m) => [...m, { role: 'user', text }])
    setThinking(true)

    // Try Claude API first (if configured) — send recent turns so multi-step
    // conversations (e.g. the permit document checklist) keep context
    const history = msgs.slice(-12).map((m) => ({ role: m.role, text: m.text }))
    let result = await callClaudeAPI(text, ctx, history)
    let usedAI = 'local'

    if (!result) {
      // Fallback to local rule-based search
      result = searchFiles(text, ctx)
    } else {
      usedAI = 'claude'
    }

    // Ensure minimum thinking time for natural feel
    await new Promise((r) => setTimeout(r, 400))

    setAiMode(usedAI)
    setThinking(false)
    setMsgs((m) => [
      ...m,
      {
        role: 'bot',
        text: result.reply,
        intent: result.intent,
        fileName: result.fileName,
        projectCode: result.projectCode,
        fileId: result.fileId,
        files: result.files || [],
        usedAI,
      },
    ])
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
              <div style={{ whiteSpace: 'pre-line' }}>{renderText(m.text)}</div>
              {m.intent === 'list' && m.files && m.files.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
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
