import Icon from './Icon.jsx'
import { fmtDate, fmtSize, TYPE_LABEL, TYPE_COLOR } from '../utils/format.js'

export default function Hero({ stats, recentFiles, projects, onUpload, onAsk }) {
  return (
    <section className="hero">
      <div className="container">
        <div className="hero-inner">
          <div>
            <div className="hero-eyebrow">
              <span className="dot"></span>
              CLAUDE HAIKU 4.5 · ONLINE
            </div>
            <h1>
              เอกสารทุกไฟล์ <span className="hl">ทุก Version</span>
              <br />
              อยู่ในมือคุณเสมอ
            </h1>
            <p className="lead">
              จัดการเอกสารก่อสร้างนับร้อยไฟล์ — EIA, แบบ, สัญญา, BOQ และ MOM —
              ในระบบเดียว AI ช่วยจัดหมวดและติดตาม Version ให้อัตโนมัติ
              แค่พิมพ์คำสั่ง ระบบดึงไฟล์ที่ถูกต้องให้คุณทันที
            </p>
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={onUpload}>
                <Icon name="upload" size={16} /> เริ่มอัปโหลดเอกสาร
              </button>
              <button className="btn btn-secondary" onClick={onAsk}>
                <Icon name="sparkles" size={16} /> ลองถาม AI
              </button>
            </div>
            <div className="hero-stats">
              <div className="stat">
                <div className="n">
                  {stats.projects}
                  <small>โครงการ</small>
                </div>
                <div className="l">PROJECTS</div>
              </div>
              <div className="stat">
                <div className="n">
                  {stats.files}
                  <small>ไฟล์</small>
                </div>
                <div className="l">DOCUMENTS</div>
              </div>
              <div className="stat">
                <div className="n">
                  {stats.types}
                  <small>ประเภท</small>
                </div>
                <div className="l">CATEGORIES</div>
              </div>
            </div>
          </div>
          <HeroPreview recentFiles={recentFiles} projects={projects} />
        </div>
      </div>
    </section>
  )
}

function HeroPreview({ recentFiles = [], projects = [] }) {
  const projectMap = {}
  projects.forEach((p) => (projectMap[p.id] = p))

  // Empty state - use placeholder
  if (recentFiles.length === 0) {
    return (
      <div className="hero-preview">
        <div className="hero-preview-head">
          <div className="lights">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div className="label">/ ระบบจัดการเอกสาร</div>
        </div>
        <div className="hero-preview-body">
          <div style={{ padding: '36px 12px', textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
            <Icon name="folder" size={36} />
            <div style={{ marginTop: 12, fontSize: 14 }}>ยังไม่มีเอกสารในระบบ</div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
              อัปโหลดเอกสารแรกเพื่อเริ่มต้น
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Show up to 3 most recent files
  const displayFiles = recentFiles.slice(0, 3)
  const firstProject = projects.find((p) => p.id === displayFiles[0]?.projectId)
  const headerLabel = firstProject ? `/ ${firstProject.code} / ${TYPE_LABEL[displayFiles[0].type] || 'ALL'}` : '/ ระบบจัดการเอกสาร'

  // Compute summary text
  const projCount = new Set(displayFiles.map((f) => f.projectId)).size
  const latestCount = displayFiles.filter((f) => f.isLatest).length
  const summaryText =
    projCount > 1
      ? `AI: เจอ ${recentFiles.length} ไฟล์ล่าสุดจาก ${projCount} โครงการ`
      : `AI: เจอ ${recentFiles.length} ไฟล์ — ${latestCount} Version ล่าสุด`

  return (
    <div className="hero-preview">
      <div className="hero-preview-head">
        <div className="lights">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div className="label">{headerLabel}</div>
      </div>
      <div className="hero-preview-body">
        {displayFiles.map((f, idx) => {
          const project = projectMap[f.projectId]
          const typeLabel = TYPE_LABEL[f.type] || f.type
          const typeColor = TYPE_COLOR[f.type] || '#6B7280'
          const isFeatured = idx === 0 && f.isLatest
          return (
            <div key={f.id} className={`hp-row ${isFeatured ? 'featured' : ''}`}>
              <div className="hp-icon" style={{ background: typeColor }}>
                {typeLabel.length > 3 ? typeLabel.slice(0, 3) : typeLabel}
              </div>
              <div className="hp-meta">
                <div className="t">{f.name}</div>
                <div className="s">
                  {fmtDate(f.date)} · {fmtSize(f.size)}
                  {project && ` · ${project.code}`}
                </div>
              </div>
              <span className={`hp-badge ${f.isLatest ? 'latest' : 'old'}`}>
                {f.isLatest ? 'ล่าสุด' : 'เก่า'}
              </span>
            </div>
          )
        })}
        <div
          style={{
            marginTop: 4,
            padding: '10px 12px',
            background: 'rgba(45,190,96,0.08)',
            border: '1px dashed rgba(45,190,96,0.3)',
            borderRadius: 10,
            fontSize: 12,
            color: 'rgba(255,255,255,0.8)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icon name="sparkles" size={14} />
          {summaryText}
        </div>
      </div>
    </div>
  )
}
