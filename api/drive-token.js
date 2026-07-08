// Vercel Serverless Function — issues a short-lived Drive access token to the client
// so uploads go directly browser -> Google Drive (bypasses Vercel's request body limit).
// Scope is restricted to drive.file (files created by this app only).
//
// Endpoint: GET /api/drive-token
// Returns: { accessToken, expiresIn, folderId }
import { getOAuthClient } from './_drive.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const client = getOAuthClient()
    const { token, res: tokenRes } = await client.getAccessToken()
    if (!token) throw new Error('Failed to obtain access token')

    return res.status(200).json({
      accessToken: token,
      expiresIn: tokenRes?.data?.expires_in || 3599,
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
    })
  } catch (err) {
    console.error('drive-token error:', err)
    return res.status(500).json({ error: err.message })
  }
}
