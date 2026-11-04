import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  getSession, signIn, signOut as apiSignOut, onAuthStateChange, fetchMyProfile, fetchMyMemberships,
  subscribeAuthProblem,
} from '../api/supabase.js'

// Who is signed in and what they may do.
//
// status:  loading | signedOut | mustChange | disabled | error | ready
// RLS is the real enforcement. canEditProject() & friends only decide what the UI offers,
// and mirror can_edit_project() / can_view_project() from scripts/auth-01-foundation.sql:
//   admin -> edits every project          exec -> edits nothing (read-only everywhere)
//   user  -> edits a project only when project_members.role = 'editor'
const AuthCtx = createContext(null)

export const useAuth = () => {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

const RECHECK_MS = 60 * 1000
const REFRESH_MIN_MS = 2000

export function AuthProvider({ children }) {
  const [status, setStatusState] = useState('loading')
  const [profile, setProfile] = useState(null)
  const [memberships, setMemberships] = useState({})
  const [membershipsFailed, setMembershipsFailed] = useState(false)
  const [notice, setNotice] = useState('') // '' | 'expired'
  const [loadError, setLoadError] = useState('')
  const [accessVersion, setAccessVersion] = useState(0)

  const statusRef = useRef('loading')
  const userIdRef = useRef(null)
  const profileRef = useRef(null)
  const membershipsRef = useRef({})
  const gen = useRef(0) // invalidates in-flight loads
  const lastCheck = useRef(0)

  const setStatus = useCallback((s) => {
    statusRef.current = s
    setStatusState(s)
  }, [])

  const resetToSignedOut = useCallback(
    (why = '') => {
      gen.current += 1
      userIdRef.current = null
      profileRef.current = null
      membershipsRef.current = {}
      setProfile(null)
      setMemberships({})
      setMembershipsFailed(false)
      setLoadError('')
      setNotice(why)
      setStatus('signedOut')
    },
    [setStatus]
  )

  // Loads the profile (+ memberships) for a session. Idempotent: a newer call wins.
  const load = useCallback(
    async (session) => {
      const my = ++gen.current
      userIdRef.current = session.user.id
      setStatus('loading')
      setLoadError('')
      try {
        const p = await fetchMyProfile()
        if (my !== gen.current) return
        if (!p) {
          profileRef.current = null
          setProfile(null)
          setStatus('disabled')
          return
        }
        profileRef.current = p
        setProfile(p)
        if (p.must_change_password) {
          setStatus('mustChange')
          return
        }
        let m = {}
        let failed = false
        try {
          m = await fetchMyMemberships(p.id)
        } catch (err) {
          failed = true
          console.warn('memberships failed:', err?.message)
        }
        if (my !== gen.current) return
        membershipsRef.current = m
        setMemberships(m)
        setMembershipsFailed(failed)
        lastCheck.current = Date.now()
        setNotice('')
        setStatus('ready')
      } catch (err) {
        if (my !== gen.current) return
        if (err?.code === 'unauthorized') {
          await apiSignOut()
          resetToSignedOut('expired')
          return
        }
        setLoadError(err?.message || 'โหลดข้อมูลบัญชีไม่สำเร็จ')
        setStatus('error')
      }
    },
    [resetToSignedOut, setStatus]
  )

  // ---- boot + auth events ----
  useEffect(() => {
    let alive = true
    getSession()
      .then((s) => {
        if (!alive) return
        if (s?.user) load(s)
        else setStatus('signedOut')
      })
      .catch(() => alive && setStatus('signedOut'))

    const unsub = onAuthStateChange((event, session) => {
      // Never call supabase from inside this callback synchronously (it can dead-lock the client).
      setTimeout(() => {
        if (!alive) return
        if (event === 'SIGNED_OUT') {
          if (statusRef.current === 'signedOut') return
          // not a logout the person asked for (those reset the state first): the session ended
          resetToSignedOut('expired')
        } else if (event === 'SIGNED_IN' && session?.user) {
          // supabase-js re-emits SIGNED_IN when a tab regains focus: only act on a different person
          if (userIdRef.current === session.user.id && statusRef.current !== 'signedOut') return
          load(session)
        }
      }, 0)
    })

    // 401 / account_disabled seen by authFetch (/api/*)
    const unsubProblem = subscribeAuthProblem((kind) => {
      if (!alive) return
      if (kind === 'disabled') {
        if (statusRef.current !== 'signedOut') setStatus('disabled')
      } else if (kind === 'expired') {
        if (statusRef.current === 'signedOut') return
        apiSignOut()
        resetToSignedOut('expired')
      }
    })

    return () => {
      alive = false
      unsub()
      unsubProblem()
    }
  }, [load, resetToSignedOut, setStatus])

  // ---- pick up deactivation / role / access changes made by an admin while the tab was open ----
  // Re-reads the profile + memberships (not throttled). Used by the focus re-check below and when a write
  // or an /api call reveals that the screen is showing stale permissions (RLS refusal, 0 rows, 403
  // password_change_required). Calls made close together share one run.
  // At most one run per REFRESH_MIN_MS: a burst of 'denied' events cannot storm the database. A call that
  // arrives too early is not lost: ONE trailing run is scheduled for when the window ends.
  const refreshInFlight = useRef(null)
  const lastRefreshAt = useRef(0)
  const trailingTimer = useRef(null)
  const refreshAccess = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current
    if (statusRef.current !== 'ready') return Promise.resolve()
    const wait = lastRefreshAt.current + REFRESH_MIN_MS - Date.now()
    if (wait > 0) {
      if (!trailingTimer.current) {
        trailingTimer.current = setTimeout(() => {
          trailingTimer.current = null
          refreshAccess()
        }, wait)
      }
      return Promise.resolve()
    }
    lastRefreshAt.current = Date.now()
    lastCheck.current = Date.now()
    const my = gen.current
    const run = (async () => {
      try {
        const p = await fetchMyProfile()
        if (my !== gen.current || statusRef.current !== 'ready') return
        if (!p) {
          setStatus('disabled')
          return
        }
        if (p.must_change_password) {
          // while the flag is set the database hides everything (is_admin / can_view_project are false):
          // go to the forced screen and leave memberships alone
          profileRef.current = p
          setProfile(p)
          setStatus('mustChange')
          return
        }
        let m = membershipsRef.current
        try {
          m = await fetchMyMemberships(p.id)
        } catch {
          /* keep what we had */
        }
        if (my !== gen.current) return
        const before = profileRef.current
        const changed =
          before?.role !== p.role ||
          before?.full_name !== p.full_name ||
          before?.must_change_password !== p.must_change_password ||
          JSON.stringify(membershipsRef.current) !== JSON.stringify(m)
        profileRef.current = p
        membershipsRef.current = m
        if (changed) {
          setProfile(p)
          setMemberships(m)
          setAccessVersion((v) => v + 1)
        }
        if (p.must_change_password) setStatus('mustChange')
      } catch (err) {
        if (err?.code === 'unauthorized') {
          await apiSignOut()
          resetToSignedOut('expired')
        }
        // network trouble: stay as we are
      } finally {
        refreshInFlight.current = null
      }
    })()
    refreshInFlight.current = run
    return run
  }, [resetToSignedOut, setStatus])

  useEffect(() => () => clearTimeout(trailingTimer.current), [])

  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== 'visible' || statusRef.current !== 'ready') return
      if (Date.now() - lastCheck.current < RECHECK_MS) return
      refreshAccess()
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('focus', recheck)
    }
  }, [refreshAccess])

  // a write was refused / matched nothing, or the server wants a password change: re-read who we are
  useEffect(
    () =>
      subscribeAuthProblem((kind) => {
        if (kind === 'denied' || kind === 'mustChange') refreshAccess()
      }),
    [refreshAccess]
  )

  // ---- actions ----
  // Throws AppError (Thai message) on failure so the form can show it.
  const login = useCallback(
    async (email, password) => {
      const { session } = await signIn(email, password)
      if (session?.user) {
        userIdRef.current = session.user.id
        await load(session)
      }
    },
    [load]
  )

  const logout = useCallback(async () => {
    resetToSignedOut('')
    await apiSignOut()
  }, [resetToSignedOut])

  // "Try again" on the account-disabled screen: re-reads the profile without leaving the screen.
  // -> 'ok' (back in the app) | 'disabled' (still deactivated) | 'unavailable' (could not check) | 'signedOut'
  const recheckAccount = useCallback(async () => {
    try {
      const s = await getSession()
      if (!s?.user) {
        resetToSignedOut('expired')
        return 'signedOut'
      }
      const p = await fetchMyProfile()
      if (!p) return 'disabled'
      await load(s)
      return 'ok'
    } catch (err) {
      if (err?.code === 'unauthorized') {
        await apiSignOut()
        resetToSignedOut('expired')
        return 'signedOut'
      }
      return 'unavailable'
    }
  }, [load, resetToSignedOut])

  const retry = useCallback(async () => {
    setStatus('loading')
    try {
      const s = await getSession()
      if (s?.user) await load(s)
      else resetToSignedOut('')
    } catch {
      resetToSignedOut('')
    }
  }, [load, resetToSignedOut, setStatus])

  // After the forced password change succeeded: reload the profile (must_change_password is now false).
  const completePasswordChange = useCallback(async () => {
    const s = await getSession()
    if (s?.user) await load(s)
    else resetToSignedOut('expired')
  }, [load, resetToSignedOut])

  const value = useMemo(() => {
    const role = profile?.role || null
    const isAdmin = role === 'admin'
    const isExec = role === 'exec'
    const isMember = role === 'user'
    const canEditProject = (projectId) => isAdmin || (isMember && memberships[projectId] === 'editor')
    const canUploadAny = isAdmin || (isMember && Object.values(memberships).includes('editor'))
    return {
      status,
      profile,
      role,
      isAdmin,
      isExec,
      isMember,
      memberships,
      membershipsFailed,
      myProjectIds: new Set(Object.keys(memberships)),
      canEditProject,
      canUploadAny,
      canCreateProject: isAdmin,
      canDeleteProject: isAdmin,
      accessVersion,
      notice,
      loadError,
      login,
      logout,
      retry,
      recheckAccount,
      refreshAccess,
      completePasswordChange,
    }
  }, [
    status, profile, memberships, membershipsFailed, accessVersion, notice, loadError,
    login, logout, retry, recheckAccount, refreshAccess, completePasswordChange,
  ])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
