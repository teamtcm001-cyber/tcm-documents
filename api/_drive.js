// Shared Google Drive helper for api/drive-*.js
// Uses a single company Google account (OAuth refresh token) as the storage backend.
// Filename starts with "_" so Vercel does not turn it into a route.
import { google } from 'googleapis'

export function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return client
}

export function getDrive() {
  return google.drive({ version: 'v3', auth: getOAuthClient() })
}
