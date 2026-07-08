// Client-side helper for uploading/reading files stored in Google Drive.
// Upload goes directly browser -> Google Drive using a short-lived token minted
// by /api/drive-token, so file bytes never pass through our own serverless
// function (avoids Vercel's request body size limit).

export async function getDriveUploadToken() {
  const res = await fetch('/api/drive-token')
  if (!res.ok) throw new Error('ไม่สามารถขอสิทธิ์อัปโหลดไป Google Drive ได้')
  return res.json()
}

export async function uploadToDrive(file) {
  const { accessToken, folderId } = await getDriveUploadToken()
  if (!accessToken || !folderId) throw new Error('Google Drive ยังไม่ได้ตั้งค่า')

  const metadata = { name: file.name, parents: [folderId] }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', file)

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    }
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`อัปโหลดขึ้น Google Drive ไม่สำเร็จ: ${errText}`)
  }
  const data = await res.json()
  return data.id
}

// storagePath (files.storage_path) holds the Drive file id.
// Returns an absolute URL — needed because Office Online's viewer fetches
// the file from Microsoft's own servers, not the browser, so a relative
// path would not resolve.
export function driveFileUrl(storagePath, { download = false, name } = {}) {
  const params = new URLSearchParams({ fileId: storagePath })
  if (download) params.set('download', '1')
  if (name) params.set('name', name)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/api/drive-file?${params.toString()}`
}
