import { useState, useEffect } from 'react'
import { supabase, fetchProjects, fetchLatestFiles } from './api/supabase.js'
import { normalizeFile } from './utils/format.js'
import { AuthProvider, useAuth } from './auth/AuthContext.jsx'
import { ToastProvider } from './components/Toast.jsx'
import LoginScreen from './components/LoginScreen.jsx'
import { LoadingScreen, DisabledScreen, ProfileErrorScreen } from './components/AuthScreens.jsx'
import { ForcedPasswordScreen, ChangePasswordDialog } from './components/ChangePassword.jsx'
import Topbar from './components/Topbar.jsx'
import Hero from './components/Hero.jsx'
import Dashboard from './components/Dashboard.jsx'
import Tracking from './components/Tracking.jsx'
import AdminConsole from './components/AdminConsole.jsx'
import ProjectDrawer from './components/ProjectDrawer.jsx'
import UploadModal from './components/UploadModal.jsx'
import NewProjectModal from './components/NewProjectModal.jsx'
import AIChat, { ChatFab } from './components/AIChat.jsx'

// Real per-person login. Order of screens:
//   loading -> login -> (forced "set a new password") -> app
// plus two blocking states: "account disabled" and "could not read the account".
// What a person may see/do is decided by the database (RLS); the UI mirrors it (see AuthContext).
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  )
}

function Gate() {
  const { status } = useAuth()
  switch (status) {
    case 'ready':
      return <MainApp />
    case 'signedOut':
      return <LoginScreen />
    case 'mustChange':
      return <ForcedPasswordScreen />
    case 'disabled':
      return <DisabledScreen />
    case 'error':
      return <ProfileErrorScreen />
    default:
      return <LoadingScreen />
  }
}

function MainApp() {
  const { isAdmin, canCreateProject, canUploadAny, membershipsFailed, accessVersion } = useAuth()
  const [active, setActive] = useState('dashboard')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [drawerProject, setDrawerProject] = useState(null)
  const [trackingProjectId, setTrackingProjectId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [heroStats, setHeroStats] = useState({ projects: 0, files: 0, types: 0 })
  const [heroFiles, setHeroFiles] = useState([])
  const [heroProjects, setHeroProjects] = useState([])

  const refresh = () => setRefreshKey((k) => k + 1)

  // an admin changed this person's access while the tab was open: reload what is on screen
  useEffect(() => {
    if (accessVersion > 0) {
      setDrawerProject(null)
      refresh()
    }
  }, [accessVersion])

  // Clicking the "ติดตามงาน" tab always returns to the cross-project overview.
  const handleNav = (id) => {
    if (id === 'tracking') setTrackingProjectId(null)
    if (id === 'admin' && !isAdmin) return
    setActive(id)
  }

  // Shortcut from the project drawer straight to one project's tracking page.
  const openTracking = (project) => {
    setDrawerProject(null)
    setTrackingProjectId(project.id)
    setActive('tracking')
  }

  const openUpload = () => {
    if (canUploadAny) setUploadOpen(true)
  }

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

  const view = active === 'admin' && !isAdmin ? 'dashboard' : active

  return (
    <div className="app">
      <Topbar
        active={view}
        onNav={handleNav}
        onOpenUpload={openUpload}
        onOpenChat={() => setChatOpen(true)}
        onChangePassword={() => setPasswordOpen(true)}
      />

      {membershipsFailed && (
        <div className="access-warning" role="alert">
          โหลดสิทธิ์รายโครงการของคุณไม่สำเร็จ — ระบบจึงแสดงเป็นอ่านอย่างเดียวชั่วคราว ลองรีเฟรชหน้านี้อีกครั้ง
        </div>
      )}

      {view === 'admin' ? (
        <AdminConsole />
      ) : view === 'tracking' ? (
        <Tracking
          projectId={trackingProjectId}
          onSelectProject={setTrackingProjectId}
          onOpenUpload={openUpload}
          onProjectChanged={refresh}
        />
      ) : (
        <>
          <Hero
            stats={heroStats}
            recentFiles={heroFiles}
            projects={heroProjects}
            canUpload={canUploadAny}
            onUpload={openUpload}
            onAsk={() => setChatOpen(true)}
          />

          <Dashboard
            refreshKey={refreshKey}
            onOpenProject={openProjectById}
            onOpenUpload={openUpload}
            onNewProject={canCreateProject ? () => setNewProjectOpen(true) : undefined}
          />
        </>
      )}

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
          onOpenTracking={openTracking}
          onStatusChanged={(row) => {
            setDrawerProject((p) => (p ? { ...p, ...row } : p))
            refresh()
          }}
        />
      )}

      {uploadOpen && canUploadAny && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onUploaded={refresh}
        />
      )}

      {newProjectOpen && canCreateProject && (
        <NewProjectModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={refresh}
        />
      )}

      {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}

      {!chatOpen && <ChatFab onClick={() => setChatOpen(true)} />}
      <AIChat open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  )
}
