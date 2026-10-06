import { useEffect } from 'react'
import TrackingOverview from './TrackingOverview.jsx'
import TrackingDetail from './TrackingDetail.jsx'

// "ติดตามงาน" tab: cross-project overview, or one project's detail when
// `projectId` is set. App owns the selection so the project drawer can deep-link here.
export default function Tracking({ projectId, onSelectProject, onOpenUpload }) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [projectId])

  if (projectId) {
    return (
      <TrackingDetail
        key={projectId}
        projectId={projectId}
        onBack={() => onSelectProject(null)}
        onOpenUpload={onOpenUpload}
      />
    )
  }
  return <TrackingOverview onOpenProject={onSelectProject} />
}
