// Vercel Serverless Function — proxies file bytes from Google Drive
// (used for preview <iframe>/<img> src and downloads) so the OAuth token
// never has to reach the client and the file doesn't need to be public.
//
// Endpoint: GET /api/drive-file?fileId=...&download=1&name=...
import { getDrive } from './_drive.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { fileId, download, name } = req.query
  if (!fileId) {
    return res.status(400).json({ error: 'Missing fileId' })
  }

  try {
    const drive = getDrive()
    const meta = await drive.files.get({ fileId, fields: 'mimeType,name' })
    const stream = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    )

    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream')
    if (download === '1') {
      const filename = name || meta.data.name || 'file'
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    }
    stream.data.pipe(res)
  } catch (err) {
    console.error('drive-file error:', err)
    return res.status(500).json({ error: err.message })
  }
}
