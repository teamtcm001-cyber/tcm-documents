// Vercel Cron (vercel.json "crons", once a day) - keeps the Supabase Free-plan project from being PAUSED
// after ~7 days without activity (long holidays). Two cheap requests with the PUBLIC (publishable / anon)
// key - the same key every browser already has, so this endpoint needs no secret and exposes nothing:
//   1. GET /auth/v1/settings                         (Auth service)
//   2. GET /rest/v1/projects?select=id&limit=1       (PostgREST -> Postgres; as anon this is refused by
//      the privileges / RLS of auth-02 - that is fine and expected: the query still reaches the database)
// When CRON_SECRET is set in Vercel, only Vercel's cron (Authorization: Bearer <CRON_SECRET>) may call it.
// Answers { ok, auth, db } with HTTP status numbers only. Nothing is written anywhere.
// It cannot WAKE a project that is already paused: that needs "Restore project" in the Supabase dashboard.
// Env: SUPABASE_URL / SUPABASE_ANON_KEY (fall back to the VITE_ values), optional CRON_SECRET.
import { getSupabaseEnv } from './_auth.js'

const TIMEOUT_MS = 10000

async function ping(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    await res.text().catch(() => '')
    return res.status
  } catch {
    return 0 // network / timeout
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  const secret = (process.env.CRON_SECRET || '').trim()
  if (secret) {
    const h = req.headers && (req.headers.authorization || req.headers.Authorization)
    if (h !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  let env
  try {
    env = getSupabaseEnv()
  } catch {
    console.error('keepalive: Supabase env missing')
    return res.status(500).json({ ok: false, error: 'server_not_configured' })
  }
  const { url, anonKey } = env
  const headers = { apikey: anonKey, Accept: 'application/json' }
  const auth = await ping(`${url}/auth/v1/settings`, headers)
  const db = await ping(`${url}/rest/v1/projects?select=id&limit=1`, headers)
  // the database answered at all (200 / 401 / 403 = it is up); 0 or 5xx = unreachable / paused
  const ok = auth > 0 && auth < 500 && db > 0 && db < 500
  console.log(`keepalive: auth=${auth} db=${db}`)
  return res.status(ok ? 200 : 503).json({ ok, auth, db, at: new Date().toISOString() })
}
