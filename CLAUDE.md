# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

TCM Document Agent — a construction-document management app for a Thai engineering company (TCM). Team members upload/version project documents (EIA, drawings, contracts, MOM, BOQ, etc.), and search them via a bilingual (Thai/English) AI-assisted chat. React + Vite frontend, Supabase (Postgres + Auth + Storage) backend, deployed on Vercel with serverless functions (AI chat via the Anthropic API, Google Drive storage).

Note: the AI MOM Writer (voice/transcript to Minutes of Meeting) and its local-Whisper transcription were removed from the app; see "Removed: MOM Writer" below.

## Commands

```bash
npm install         # install deps
npm run dev          # start Vite dev server on http://localhost:5173
npm run build        # production build -> dist/
npm run preview      # preview the production build locally
npm run deploy       # vercel deploy --prod
```

There is no test suite or linter configured in this repo — don't invent `npm test`/`npm run lint` commands.

Environment variables (see `.env.example`) go in `.env.local` for local dev:
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — required for the app to function at all (auth/db/storage).
- `ANTHROPIC_API_KEY` — set only in Vercel (server-side, used by `api/chat.js`). When absent, the serverless function and client both fall back to non-AI behavior (see "AI features degrade gracefully" below).

## Architecture

### Two independent apps in one repo
- **`src/` (the real app)** — React 18 + Vite SPA, entry `src/main.jsx` → `src/App.jsx`. This is what `npm run dev`/`npm run build` operate on and what's deployed.
- **`qto/` + `TCM_QTO_Agent.html`** — a separate, self-contained "QTO Agent" (quantity take-off) tool: plain JS modules loaded directly by a standalone HTML file, no build step, no Supabase. The user pastes their own Anthropic API key into the page (stored in `localStorage`) and it calls the Anthropic API directly from the browser. Unrelated to the Vite app's routing/build.
- **`TCM Document Agent.html`** is a legacy pre-Vite prototype (references `src/data.js`, `src/icons.jsx`, etc. that no longer exist under `src/`). It is not part of the current build — don't treat missing files it references as a bug.

### Data model (Supabase Postgres, see `SQL_SCHEMA.sql` / `MIGRATION_CONTENT_SEARCH.sql`)
- `projects` — one row per construction project (`code` is the human-facing short id, e.g. `MRT-PP`). Still has legacy columns `mom_topics`, `mom_logo`, `mom_font` (per-project MOM template config) that nothing in the app reads or writes any more; they are intentionally left in the DB (see "Removed: MOM Writer").
- `files` — a document row per uploaded version. Versioning is by `(project_id, type, base_name)`: each upload marks prior rows with the same base_name as `is_latest = false` (done client-side in `uploadFile`, see `src/api/supabase.js`). `content_text` holds extracted plain text used for search (nullable — code must tolerate the column not existing yet, see the retry-without-content_text logic in `uploadFile`).
- `activity` — timeline/audit log per project.
- `profiles` — one row per person allowed in (`role` admin|exec|user, `active`, `must_change_password`); `project_members` — per-project access (`editor`/`viewer`, one row per project+user). Both come from `scripts/auth-01-foundation.sql`.
- Storage bucket `documents`: object keys are sanitized ASCII-only (`sanitizeStorageKey` in `src/api/supabase.js`) because Supabase Storage rejects non-ASCII (e.g. Thai) keys — the real filename is preserved separately in the `name` column for display/download.

### `src/api/supabase.js` is the single data-access layer
All DB/storage/auth calls go through this file (no other module talks to Supabase directly). Components import named functions from it (`fetchProjects`, `uploadFile`, `fetchActivity`, `getFilePublicUrl`, etc.) rather than using the `supabase` client directly.

### Authentication and access (real per-person login)
- Email + password login (`supabase.auth.signInWithPassword`); there is no self sign-up and no email recovery — an admin creates accounts and resets passwords through `POST /api/admin-users` (service-role key, server only). The temporary password is returned once and must never be stored or logged. The old shared-account auto-login, `NameGate`, `logVisit` and `localIdentity` were removed.
- `src/auth/AuthContext.jsx` owns the gate (loading → login → forced "ตั้งรหัสผ่านใหม่" when `profiles.must_change_password` → app, plus a blocking "account disabled" screen) and exposes `useAuth()`: `profile`, `role` (`admin | exec | user`), `memberships` (`project_members` of the signed-in user, fetched once), `canEditProject(id)`, `canUploadAny`. UI gating mirrors RLS (admin edits all, exec is read-only everywhere, user edits only projects where `project_members.role = 'editor'`) — RLS (`scripts/auth-01-foundation.sql`, `auth-02-enforce-rls.sql`) is the real enforcement.
- Calls to our own `/api/*` functions (chat, drive-token, drive-url, admin-users) must go through `authFetch` in `src/api/supabase.js` (adds the Bearer token, refreshes once on 401, reports 401 → "เซสชันหมดอายุ" and 403 `account_disabled` → blocked screen).
- Files are only served through short-lived signed URLs: `getSignedFileUrl(fileId)` → `POST /api/drive-url` (takes the `files.id` row id, not the Drive id) → `/api/drive-file?...sig=...`. Previews, downloads and re-index all mint a fresh URL first; a `link_expired` answer is retried once.
- The audit trail (who did what) is written by database triggers and is admin-only; the UI deliberately shows no uploader/updater names for new data (`uploader_name`, `activity.user_name`, tracking `updated_by` stay null/'-').
- Server env vars (never `VITE_`): `SUPABASE_SERVICE_ROLE_KEY`, `DRIVE_URL_SECRET` (>= 32 chars), plus the existing Google ones. See `.env.example`.

### AI features degrade gracefully when no API key is configured
The AI serverless function under `api/` (Vercel Function, plain `handler(req,res)`, not part of the Vite build) proxies to `https://api.anthropic.com/v1/messages` using `ANTHROPIC_API_KEY` from the server environment:
- `api/chat.js` — AI Document Agent chat (`POST /api/chat`): given a query + project/file context, returns intent (`list`/`download_zip`/`answer`) and matching file ids.

The other functions under `api/` (`_drive.js`, `drive-file.js`, `drive-token.js`) handle Google Drive storage and do not call Anthropic.

If `ANTHROPIC_API_KEY` is unset, or the Anthropic call fails/parses badly, `api/chat.js` returns `{ fallback: true }` or `{ reply: '__USE_LOCAL__' }` with HTTP 200 (never a hard error) — the client is expected to check for this signal and fall back to local logic: chat falls back to `src/utils/aiSearch.js`, a rule-based Thai/English NL search engine (synonym dictionary, time-range parsing, filters) run entirely client-side.

When adding new AI-backed features, follow this same pattern: serverless proxy + explicit fallback signal + client-side non-AI path, rather than making the AI call a hard dependency.

### Document text extraction (`src/utils/textExtract.js`)
Client-side extraction of PDF/DOCX/XLSX/TXT content (via `pdfjs-dist`, `mammoth`, `xlsx`) happens at upload time so `content_text` can be stored for search, and again on-demand via a project drawer "re-index" action for files uploaded before this feature existed. PDF.js loads its worker from a CDN (jsdelivr) rather than bundling it, deliberately, for build reliability.

### File type taxonomy (`src/utils/format.js`)
Eight document types (`eia`, `drawing`, `contract`, `labor`, `standard`, `mom`, `boq`, `other`) with associated Thai labels/colors, and `detectType()` auto-classifies uploads by filename keywords (Thai + English). Version strings (`rev1`, `v2`, dates) are stripped from filenames via `deriveBaseName()`/`detectVersion()` to compute the `base_name` used for version grouping.

### Removed: MOM Writer
The AI MOM Writer (`MOMWriter.jsx`, per-project MOM template modal, `momDefaults.js`, `pdfFormExtract.js`, client-side Whisper transcription in `localWhisper.js`, `api/mom.js`, `api/extract-form.js`, and the `@xenova/transformers` / `mediabunny` dependencies) was taken out of the app on request, for now. It can be restored from git history; the last commit that still contains it is `0ebfd03` ("Add opt-in faster transcription mode (whisper-tiny) for long recordings"), e.g. `git show 0ebfd03:src/components/MOMWriter.jsx`. What stays: the `mom` document type in the taxonomy above (uploaded MOM files are still stored/searched like any other document) and the unused `projects.mom_*` DB columns.
