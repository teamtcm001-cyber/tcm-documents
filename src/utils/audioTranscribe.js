// Client-side audio transcription pipeline (real STT via /api/transcribe -> OpenAI Whisper).
//
// Vercel serverless functions cap request bodies at ~4.5MB, so a long meeting
// recording can't be sent in one request. Instead we decode the whole
// recording in the browser, resample it to 16kHz mono (Whisper's native rate,
// and much smaller than the mic's native 44.1/48kHz), and slice it into
// short WAV chunks that are always well under the limit. Each chunk is
// transcribed independently and the text is joined back together in order.

const CHUNK_SECONDS = 120 // ~3.8MB per chunk at 16kHz/16-bit mono, safely under Vercel's ~4.5MB body limit
const SAMPLE_RATE = 16000

async function decodeToMonoPCM(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer)
  } finally {
    ctx.close()
  }

  const duration = decoded.duration
  const offline = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0) // Float32Array, mono, 16kHz
}

function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

// Splits a full recording into a sequence of short WAV blobs.
export async function chunkAudio(blob) {
  const pcm = await decodeToMonoPCM(blob)
  const chunkLen = CHUNK_SECONDS * SAMPLE_RATE
  const chunks = []
  for (let i = 0; i < pcm.length; i += chunkLen) {
    chunks.push(encodeWav(pcm.subarray(i, i + chunkLen)))
  }
  return chunks.length ? chunks : [encodeWav(pcm)]
}

async function transcribeChunk(wavBlob) {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wavBlob,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `ถอดเสียงไม่สำเร็จ (${res.status})`)
  }
  const data = await res.json()
  if (data.fallback) {
    throw new Error('ระบบถอดเสียง AI ยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า) กรุณาติดต่อผู้ดูแลระบบ')
  }
  return data.text || ''
}

// Decodes + chunks + transcribes a full recording, reporting progress as it goes.
// onProgress(doneCount, totalCount) is called after each chunk finishes.
export async function transcribeAudio(blob, onProgress) {
  const chunks = await chunkAudio(blob)
  const parts = []
  for (let i = 0; i < chunks.length; i++) {
    parts.push(await transcribeChunk(chunks[i]))
    onProgress?.(i + 1, chunks.length)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
