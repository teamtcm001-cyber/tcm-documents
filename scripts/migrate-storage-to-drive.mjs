// One-time migration: copy existing files from Supabase Storage into Google Drive
// and repoint files.storage_path to the new Drive file id. The original Supabase
// Storage object is left untouched (safe to re-run / roll back).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... GOOGLE_DRIVE_FOLDER_ID=... \
//   node scripts/migrate-storage-to-drive.mjs [--dry-run]
import { createClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { Readable } from 'stream'

const DRY_RUN = process.argv.includes('--dry-run')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function getDrive() {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return google.drive({ version: 'v3', auth: oauth2Client })
}

async function run() {
  const drive = getDrive()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  const { data: files, error } = await supabase.from('files').select('id, name, storage_path')
  if (error) throw error

  // Supabase Storage paths look like "{projectId}/{timestamp}-{name}" (contain "/").
  // Drive file ids never contain "/", so this also makes the script safe to re-run.
  const toMigrate = files.filter((f) => f.storage_path && f.storage_path.includes('/'))

  console.log(`Total files: ${files.length}. Need migration: ${toMigrate.length}.`)
  if (DRY_RUN) {
    toMigrate.forEach((f) => console.log(`  would migrate: ${f.name} (${f.storage_path})`))
    return
  }

  let ok = 0
  let failed = 0
  for (const f of toMigrate) {
    try {
      const { data: blob, error: dlErr } = await supabase.storage.from('documents').download(f.storage_path)
      if (dlErr) throw dlErr
      const buffer = Buffer.from(await blob.arrayBuffer())

      const driveRes = await drive.files.create({
        requestBody: { name: f.name, parents: [folderId] },
        media: { mimeType: blob.type || 'application/octet-stream', body: Readable.from(buffer) },
        fields: 'id',
      })

      const { error: updErr } = await supabase
        .from('files')
        .update({ storage_path: driveRes.data.id })
        .eq('id', f.id)
      if (updErr) throw updErr

      console.log(`OK    ${f.name} -> ${driveRes.data.id}`)
      ok++
    } catch (err) {
      console.error(`FAIL  ${f.name} (${f.id}): ${err.message}`)
      failed++
    }
  }
  console.log(`Done. ok=${ok} failed=${failed}`)
}

run().catch((err) => {
  console.error('Migration script error:', err)
  process.exit(1)
})
