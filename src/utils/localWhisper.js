// Fully client-side speech-to-text using a WASM-compiled Whisper model
// (@xenova/transformers) — no server call, no API key, no cost. The
// trade-off vs. a hosted GPU-backed Whisper API: slower (runs on the
// user's CPU via WASM) and less accurate, especially for Thai, since the
// model has to be small enough to run in a browser tab. Chosen anyway
// because the team doesn't want to attach a payment method to any AI
// provider for this feature.

let transcriberPromise = null

function getTranscriber(onModelProgress) {
  if (!transcriberPromise) {
    transcriberPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      // Without this, the library checks a local "/models/" path first — which
      // doesn't exist on this app's server, and a dev/prod SPA fallback returns
      // index.html for it, which then fails to parse as the JSON/model file it
      // expected. Force it straight to the Hugging Face Hub instead.
      env.allowLocalModels = false
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        progress_callback: onModelProgress,
      })
    })
  }
  return transcriberPromise
}

async function decodeToMonoPCM(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer)
  } catch (e) {
    throw new Error(
      'เบราว์เซอร์นี้เปิดไฟล์นี้ไม่ได้ (มักเกิดกับไฟล์วิดีโอบางชนิด) — ลองใช้ Google Chrome หรือดาวน์โหลดแบบ "Audio only" จาก Zoom/Teams แทน'
    )
  } finally {
    ctx.close()
  }

  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0) // Float32Array, mono, 16kHz
}

// onStatus receives { phase: 'loading-model' | 'decoding' | 'transcribing', progress? }
export async function transcribeLocally(blob, onStatus) {
  onStatus?.({ phase: 'loading-model', progress: 0 })
  const transcriber = await getTranscriber((p) => {
    if (p.status === 'progress') {
      onStatus?.({ phase: 'loading-model', progress: Math.round(p.progress || 0) })
    }
  })

  onStatus?.({ phase: 'decoding' })
  const pcm = await decodeToMonoPCM(blob)

  onStatus?.({ phase: 'transcribing' })
  const result = await transcriber(pcm, {
    language: 'thai',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  })

  return (result.text || '').trim()
}
