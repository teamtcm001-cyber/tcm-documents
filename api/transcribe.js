// Vercel Serverless Function — speech-to-text via OpenAI Whisper
// Activates when OPENAI_API_KEY env var is set in Vercel
//
// Endpoint: POST /api/transcribe
// Body: raw audio/wav bytes (a short chunk — see src/utils/audioTranscribe.js
// for why the client splits long recordings into pieces before calling this)
// Returns: { text } or { fallback: true } if no API key is configured

export const config = {
  api: { bodyParser: false },
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return res.status(200).json({ fallback: true, error: 'OPENAI_API_KEY not configured' })
  }

  try {
    const audioBuffer = await readRawBody(req)
    if (!audioBuffer.length) {
      return res.status(400).json({ error: 'Missing audio body' })
    }

    const form = new FormData()
    form.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', 'whisper-1')
    form.append('language', 'th')

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('OpenAI Whisper API error:', response.status, errorText)
      return res.status(200).json({ fallback: true, error: `Whisper API error: ${response.status}` })
    }

    const data = await response.json()
    return res.status(200).json({ text: data.text || '' })
  } catch (err) {
    console.error('Transcribe handler error:', err)
    return res.status(500).json({ error: err.message })
  }
}
