import { useState, useEffect } from 'react'
import { supabase, getCurrentUser, signIn, logVisit, fetchProjects, fetchLatestFiles } from './api/supabase.js'
import { normalizeFile } from './utils/format.js'
import { getLocalName } from './utils/localIdentity.js'
import { ToastProvider } from './components/Toast.jsx'
import NameGate from './components/NameGate.jsx'
import Topbar from './components/Topbar.jsx'
import Hero from './components/Hero.jsx'
import Dashboard from './components/Dashboard.jsx'
import ProjectDrawer from './components/ProjectDrawer.jsx'
import UploadModal from './components/UploadModal.jsx'
import NewProjectModal from './components/NewProjectModal.jsx'
import AIChat, { ChatFab } from './components/AIChat.jsx'
import MOMWriter from './components/MOMWriter.jsx'

// No login screen — every visitor is signed in as one shared account behind
// the scenes so Supabase RLS (which requires an authenticated session) keeps
// working. Activity/uploads all show up under this shared account.
const SHARED_EMAIL = import.meta.env.VITE_SHARED_ACCOUNT_EMAIL
const SHARED_PASSWORD = import.meta.env.VITE_SHARED_ACCOUNT_PASSWORD

export default function App() {
  const [user, setUser] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [localName, setLocalNameState] = useState(() => getLocalName())
  const [editingName, setEditingName] = useState(false)

  useEffect(() => {
    // getCurrentUser() rejects (not resolves to null) when there's no session yet,
    // e.g. a fresh browser — treat that as "not signed in", not a fatal error.
    getCurrentUser()
      .catch(() => null)
      .then((u) => u || signIn(SHARED_EMAIL, SHARED_PASSWORD).then((r) => r.user))
      .then(setUser)
      .catch((err) => {
        console.error('shared sign-in failed:', err)
        setAuthError(err.message || 'เข้าใช้งานระบบไม่สำเร็จ')
      })
  }, [])

  if (authError) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <p>ไม่สามารถเชื่อมต่อระบบได้: {authError}</p>
          <p className="muted small">ลองรีเฟรชหน้านี้ใหม่อีกครั้ง</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="spinner"></div>
      </div>
    )
  }

  if (!localName || editingName) {
    return (
      <NameGate
        initialValue={localName}
        onDone={(n) => {
          setLocalNameState(n)
          setEditingName(false)
        }}
        onCancel={localName ? () => setEditingName(false) : undefined}
      />
    )
  }

  // Overlay the self-reported name onto the shared account's user object so
  // every existing user_metadata.full_name read (Topbar, uploads, MOM) shows
  // the real person instead of the shared account for everyone.
  const displayUser = { ...user, user_metadata: { ...user.user_metadata, full_name: localName } }

  return <Ready displayUser={displayUser} localName={localName} onChangeName={() => setEditingName(true)} />
}

// Logs one visit row per app load (covers both first-time name entry and
// returning visitors whose name is already cached) — the only backend trail
// of who's using the app, since everyone otherwise shares one account.
function Ready({ displayUser, localName, onChangeName }) {
  useEffect(() => {
    logVisit(localName)
  }, [localName])

  return (
    <ToastProvider>
      <MainApp user={displayUser} onChangeName={onChangeName} />
    </ToastProvider>
  )
}

function MainApp({ user, onChangeName }) {
  const [active, setActive] = useState('dashboard')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [momOpen, setMomOpen] = useState(false)
  const [drawerProject, setDrawerProject] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [heroStats, setHeroStats] = useState({ projects: 0, files: 0, types: 0 })
  const [heroFiles, setHeroFiles] = useState([])
  const [heroProjects, setHeroProjects] = useState([])

  const refresh = () => setRefreshKey((k) => k + 1)

  useEffect(() => {
    loadHeroData()
  }, [refreshKey])

  const loadHeroData = async () => {
    try {
      const projects = await fetchProjects()
      setHeroProjects(projects)

      const { count: fileCount } = await supabase.from('files').select('id', { count: 'exact', head: true })
      const { data: typesData } = await supabase.from('files').select('type')
      const typeSet = new Set((typesData || []).map((f) => f.type))
      setHeroStats({
        projects: projects.length,
        files: fileCount || 0,
        types: typeSet.size || 8,
      })

      // Get recent files for preview (latest from each project)
      const latestRows = await fetchLatestFiles(8)
      const normalized = (latestRows || []).map(normalizeFile)
      // Sort by date desc and pick latest distinct per project (max 3)
      const sorted = [...normalized].sort((a, b) => new Date(b.date) - new Date(a.date))
      const seen = new Set()
      const oneFromEach = []
      for (const f of sorted) {
        if (!seen.has(f.projectId)) {
          oneFromEach.push(f)
          seen.add(f.projectId)
          if (oneFromEach.length >= 3) break
        }
      }
      // If we have fewer projects, fill with other latest files
      if (oneFromEach.length < 3) {
        for (const f of sorted) {
          if (!oneFromEach.find((x) => x.id === f.id)) {
            oneFromEach.push(f)
            if (oneFromEach.length >= 3) break
          }
        }
      }
      setHeroFiles(oneFromEach)
    } catch (err) {
      console.error('hero data:', err)
    }
  }

  const openProjectById = async (projectId) => {
    try {
      const projects = await fetchProjects()
      const found = projects.find((p) => p.id === projectId)
      if (found) setDrawerProject(found)
    } catch (err) {
      console.error('open project:', err)
    }
  }

  return (
    <div className="app">
      <Topbar
        user={user}
        active={active}
        onNav={setActive}
        onOpenUpload={() => setUploadOpen(true)}
        onOpenChat={() => setChatOpen(true)}
        onOpenMOM={() => setMomOpen(true)}
        onChangeName={onChangeName}
      />

      <Hero
        stats={heroStats}
        recentFiles={heroFiles}
        projects={heroProjects}
        onUpload={() => setUploadOpen(true)}
        onAsk={() => setChatOpen(true)}
        onOpenMOM={() => setMomOpen(true)}
      />

      <Dashboard
        refreshKey={refreshKey}
        onOpenProject={openProjectById}
        onOpenUpload={() => setUploadOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />

      <footer className="footer">
        TCM Document Agent · v5 Engineering Edition · Powered by Claude Haiku 4.5
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--gray-400)' }}>
          © {new Date().getFullYear()} TCM
        </div>
      </footer>

      {drawerProject && (
        <ProjectDrawer
          project={drawerProject}
          refreshKey={refreshKey}
          onClose={() => setDrawerProject(null)}
          onChanged={refresh}
        />
      )}

      {uploadOpen && (
        <UploadModal
          user={user}
          onClose={() => setUploadOpen(false)}
          onUploaded={refresh}
        />
      )}

      {newProjectOpen && (
        <NewProjectModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={refresh}
        />
      )}

      {!chatOpen && <ChatFab onClick={() => setChatOpen(true)} />}
      <AIChat open={chatOpen} onClose={() => setChatOpen(false)} />

      {momOpen && (
        <MOMWriter
          projects={heroProjects}
          user={user}
          onClose={() => setMomOpen(false)}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
