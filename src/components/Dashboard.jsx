import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { fetchProjects, fetchFiles } from '../api/supabase.js'
import { fmtSize, fmtDate, normalizeFile, computeIsLatest, TYPE_LABEL, TYPE_COLOR, TYPE_BG, TYPE_TEXT } from '../utils/format.js'

function StatCards({ projects, files }) {
  const latestCount = files.filter((f) => f.isLatest).length
  const ageDays = (d) => (Date.now() - new Date(d)) / 86400000
  const last7 = files.filter((f) => ageDays(f.date) <= 7).length
  const prev7 = files.filter((f) => ageDays(f.date) > 7 && ageDays(f.date) <= 14).length
  const newProjects30 = projects.filter((p) => p.created_at && ageDays(p.created_at) <= 30).length
  const totalKB = files.reduce((s, f) => s + (f.size || 0), 0)
  const totalGB = (totalKB / 1024 / 1024).toFixed(1)

  // Every note below is computed from the loaded data (nothing hardcoded).
  const cards = [
    { lbl: 'โครงการทั้งหมด', val: projects.length, suf: 'โครงการ', trend: `ใหม่ใน 30 วัน: ${newProjects30}`, flat: true, icon: 'building', color: '#3A6EA5', bg: 'rgba(58,110,165,0.12)' },
    { lbl: 'ไฟล์ทั้งหมด', val: files.length, suf: 'ไฟล์', trend: `${latestCount} Latest`, icon: 'file', color: '#2DBE60', bg: 'rgba(45,190,96,0.12)' },
    { lbl: 'เพิ่มใหม่ (7 วัน)', val: last7, suf: 'ไฟล์', trend: `7 วันก่อนหน้า: ${prev7} ไฟล์`, flat: true, icon: 'upload', color: '#F5A623', bg: 'rgba(245,166,35,0.14)' },
    { lbl: 'ขนาดไฟล์รวม', val: totalGB, suf: 'GB', trend: 'รวมทุกเวอร์ชัน', flat: true, icon: 'layers', color: '#6E56CF', bg: 'rgba(110,86,207,0.12)' },
  ]

  return (
    <div className="stats-grid">
      {cards.map((c, i) => (
        <div className="stat-card" key={i}>
          <div className="lbl">
            <div className="ico" style={{ background: c.bg, color: c.color }}>
              <Icon name={c.icon} size={15} />
            </div>
            {c.lbl}
          </div>
          <div className="v">
            {c.val}
            <small>{c.suf}</small>
          </div>
          <div className={`trend ${c.flat ? 'flat' : ''}`}>
            <Icon name={c.flat ? 'clock' : 'trend-up'} size={12} />
            {c.trend}
          </div>
        </div>
      ))}
    </div>
  )
}

function ProjectCard({ project, fileCount, latestDate, onOpen, onZip }) {
  return (
    <div className="proj-card" onClick={onOpen}>
      <div className="proj-thumb" style={{ background: project.color || '#3A6EA5' }}>
        {(project.code || '?').slice(0, 3)}
      </div>
      <div className="proj-meta">
        <div className="name">{project.name}</div>
        <div className="info">
          <span>
            <Icon name="file" size={11} /> {fileCount} ไฟล์
          </span>
          <span>
            <Icon name="clock" size={11} /> อัปเดต {latestDate ? fmtDate(latestDate) : '-'}
          </span>
          {project.status && <span style={{ color: 'var(--steel)' }}>{project.status}</span>}
        </div>
      </div>
      <div className="proj-actions">
        <button
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            onZip?.()
          }}
          title="Zip ล่าสุด"
        >
          <Icon name="zip" size={15} />
        </button>
        <button className="icon-btn" title="เปิดดู">
          <Icon name="arrow-r" size={15} />
        </button>
      </div>
    </div>
  )
}

function DocTypeChart({ files }) {
  const counts = {}
  files.forEach((f) => {
    counts[f.type] = (counts[f.type] || 0) + 1
  })
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    return <div className="muted small" style={{ padding: 12, textAlign: 'center' }}>ยังไม่มีข้อมูล</div>
  }
  const max = Math.max(...entries.map((e) => e[1]))
  return (
    <div className="dtype-bar">
      {entries.map(([t, n]) => (
        <div className="dtype-row" key={t}>
          <span className="lab">{TYPE_LABEL[t] || t}</span>
          <div className="bar">
            <div className="fill" style={{ width: `${(n / max) * 100}%`, background: TYPE_COLOR[t] || '#6B7280' }} />
          </div>
          <span className="n">{n}</span>
        </div>
      ))}
    </div>
  )
}

function RecentActivity({ files, projects }) {
  const projName = (id) => projects.find((p) => p.id === id)?.name || ''
  const recent = [...files].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6)
  if (recent.length === 0) {
    return <div className="muted small" style={{ padding: 12, textAlign: 'center' }}>ยังไม่มีกิจกรรม</div>
  }
  return (
    <div className="timeline">
      {recent.map((f) => (
        <div className="tl-item" key={f.id}>
          <div
            className="tl-dot"
            style={f.isLatest ? { background: 'var(--green-50)', color: '#1F8E48' } : undefined}
          >
            <Icon name={f.isLatest ? 'sparkles' : 'file'} size={13} />
          </div>
          <div className="tl-body">
            <div>
              <span className="t">{f.name}</span>
            </div>
            <div style={{ color: 'var(--gray-500)', fontSize: 12 }}>{projName(f.projectId)}</div>
            <div className="when">
              {fmtDate(f.date)} · {fmtSize(f.size)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard({ refreshKey, onOpenProject, onOpenUpload, onZipProject, onNewProject }) {
  const [projects, setProjects] = useState([])
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [refreshKey])

  const load = async () => {
    setLoading(true)
    try {
      const projData = await fetchProjects()
      setProjects(projData)
      const allFiles = []
      for (const p of projData) {
        const rows = await fetchFiles(p.id)
        rows.forEach((r) => allFiles.push(normalizeFile(r)))
      }
      computeIsLatest(allFiles)
      setFiles(allFiles)
    } catch (err) {
      console.error('load dashboard:', err)
    } finally {
      setLoading(false)
    }
  }

  const projInfo = projects
    .map((p) => {
      const fs = files.filter((f) => f.projectId === p.id)
      const latestDate = fs.reduce((a, f) => (new Date(f.date) > new Date(a) ? f.date : a), '2000-01-01')
      return { project: p, fileCount: fs.length, latestDate }
    })
    .sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate))

  if (loading) {
    return (
      <section className="section">
        <div className="container" style={{ display: 'grid', placeItems: 'center', minHeight: 280 }}>
          <div className="spinner"></div>
        </div>
      </section>
    )
  }

  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div className="section-title">
            <h2>ภาพรวมระบบ</h2>
            <div className="sub">ข้อมูลล่าสุดของระบบจัดการเอกสาร · อัปเดตทุก {fmtDate(new Date().toISOString().slice(0, 10))}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onNewProject}>
              <Icon name="plus" size={14} /> โครงการใหม่
            </button>
            <button className="btn btn-primary btn-sm" onClick={onOpenUpload}>
              <Icon name="plus" size={14} /> เพิ่มเอกสาร
            </button>
          </div>
        </div>

        <StatCards projects={projects} files={files} />

        <div style={{ height: 28 }} />

        <div className="dash-grid">
          <div className="pane">
            <h3>
              <span>โครงการล่าสุด</span>
              <a>
                ดูทั้งหมด <Icon name="arrow-r" size={12} />
              </a>
            </h3>
            {projInfo.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--gray-500)' }}>
                <Icon name="folder" size={32} />
                <div style={{ marginTop: 8 }}>ยังไม่มีโครงการ</div>
                <button className="btn btn-primary btn-sm" onClick={onNewProject} style={{ marginTop: 16 }}>
                  <Icon name="plus" size={14} /> สร้างโครงการแรก
                </button>
              </div>
            ) : (
              <div className="proj-list">
                {projInfo.map(({ project, fileCount, latestDate }) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    fileCount={fileCount}
                    latestDate={latestDate}
                    onOpen={() => onOpenProject(project.id)}
                    onZip={() => onZipProject?.(project)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="pane">
            <h3>ประเภทเอกสาร</h3>
            <div className="card" style={{ padding: 20, marginBottom: 20 }}>
              <DocTypeChart files={files} />
            </div>
            <h3>กิจกรรมล่าสุด</h3>
            <div className="card" style={{ padding: 16 }}>
              <RecentActivity files={files} projects={projects} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
