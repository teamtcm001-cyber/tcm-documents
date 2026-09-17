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

// How much decoded audio to accumulate before resampling it down to 16kHz
// mono and releasing the source-format buffers. Matches the chunk_length_s
// passed to the Whisper pipeline below, mostly for consistency — it's not
// required to match, it's just a reasonable window size that keeps peak
// memory bounded regardless of the recording's total length.
const DECODE_CHUNK_SECONDS = 30

// Resamples a single AudioBuffer (whatever its native sample rate/channel
// count) down to mono 16kHz using an OfflineAudioContext, same approach the
// whole-file path used before.
async function resampleBufferTo16kMono(audioBuffer) {
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000)
  const source = offline.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

// Concatenates a run of AudioBuffers (same sample rate) into a single
// AudioBuffer so they can be resampled together in one
// OfflineAudioContext pass instead of one pass per tiny decoded packet.
function mergeAudioBuffers(buffers) {
  const sampleRate = buffers[0].sampleRate
  const numberOfChannels = Math.max(...buffers.map((b) => b.numberOfChannels))
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
  const merged = new AudioBuffer({ numberOfChannels, length: totalLength, sampleRate })
  let offset = 0
  for (const buf of buffers) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = buf.getChannelData(ch < buf.numberOfChannels ? ch : 0)
      merged.copyToChannel(data, ch, offset)
    }
    offset += buf.length
  }
  return merged
}

// Marks an error as having happened while merely opening/demuxing the file
// (before any audio was actually decoded) — as opposed to a failure partway
// through the chunked decode loop, once decoding has meaningfully started.
function markAsSetupFailure(error) {
  error.mediabunnySetupFailed = true
  return error
}

// Primary decode path: demux the container and decode the audio track via
// Mediabunny (which uses the native WebCodecs AudioDecoder under the hood),
// consuming decoded audio in small windows instead of asking the browser to
// decode the entire file into memory at once. This is what makes long
// (30min-2hr+) Zoom/Teams recordings work — decodeAudioData()'ing a whole
// 1-hour recording can be ~1.2GB of PCM and reliably fails/OOMs.
//
// Only failures during the initial open/demux (or the very first decoded
// buffer) are marked recoverable via markAsSetupFailure(): those genuinely
// mean Mediabunny couldn't read this file at all, so falling back to the
// whole-file decoder is reasonable. A failure later in the loop means
// decoding was working and something went wrong mid-stream (bad frame,
// transient WebCodecs error, etc.) — that must NOT silently fall back to a
// whole-file decode, since that's exactly the OOM failure mode this whole
// chunked approach exists to avoid. It's left unmarked so the caller lets
// it propagate as a real error instead.
async function decodeToMonoPCMWithMediabunny(blob, onProgress) {
  const { ALL_FORMATS, BlobSource, Input, AudioBufferSink } = await import('mediabunny')

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      const noTrackError = markAsSetupFailure(new Error('mediabunny: no audio track found in file'))
      noTrackError.mediabunnyNoAudioTrack = true
      throw noTrackError
    }

    // Cheap, metadata-only duration lookup, used only to report progress.
    // If it's unavailable, we just skip progress reporting.
    let totalDuration = null
    try {
      totalDuration = await track.getDurationFromMetadata({ skipLiveWait: true })
    } catch {
      totalDuration = null
    }

    const sink = new AudioBufferSink(track)
    const iterator = sink.buffers()

    // Fetching the first buffer is still part of "opening" the stream: if
    // this throws, Mediabunny couldn't actually decode anything from this
    // file, so it's safe to fall back. Everything after this point counts
    // as "decoding has started".
    let next
    try {
      next = await iterator.next()
    } catch (e) {
      throw markAsSetupFailure(e)
    }

    const resampledChunks = []
    let pending = []
    let pendingDuration = 0
    let decodedSoFar = 0

    const flushPending = async () => {
      if (pending.length === 0) return
      const merged = mergeAudioBuffers(pending)
      resampledChunks.push(await resampleBufferTo16kMono(merged))
      pending = []
      pendingDuration = 0
    }

    // From here on, errors are NOT marked as setup failures — they propagate
    // as-is so the caller does not fall back to the OOM-prone whole-file path.
    while (!next.done) {
      const { buffer, duration } = next.value
      pending.push(buffer)
      pendingDuration += duration
      decodedSoFar += duration
      if (totalDuration) {
        onProgress?.(Math.min(100, Math.round((decodedSoFar / totalDuration) * 100)))
      }
      if (pendingDuration >= DECODE_CHUNK_SECONDS) {
        await flushPending()
      }
      next = await iterator.next()
    }
    await flushPending()

    if (resampledChunks.length === 0) {
      throw markAsSetupFailure(new Error('mediabunny: decoded no audio data'))
    }

    const totalLength = resampledChunks.reduce((sum, c) => sum + c.length, 0)
    const result = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of resampledChunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  } finally {
    // Defensive cleanup: free the demuxer/source now rather than waiting on
    // GC, since this function may run repeatedly in one session.
    input.dispose?.()
  }
}

// Fallback decode path (whole file at once via the browser's built-in
// decoder). Used only when Mediabunny itself can't demux/read the file at
// all (e.g. a truly unsupported container) — not the primary path, since
// this is the approach that fails on long recordings.
async function decodeToMonoPCMWithAudioContext(blob) {
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

  return resampleBufferTo16kMono(decoded)
}

async function decodeToMonoPCM(blob, onProgress) {
  try {
    return await decodeToMonoPCMWithMediabunny(blob, onProgress)
  } catch (mediabunnyError) {
    if (!mediabunnyError?.mediabunnySetupFailed) {
      // Decoding had already started making progress when this happened —
      // falling back now would mean re-decoding the whole file at once,
      // which is the exact OOM-prone path this fix exists to avoid. Let it
      // surface as a real error instead of silently retrying.
      throw mediabunnyError
    }

    // eslint-disable-next-line no-console
    console.warn('mediabunny decode failed, falling back', mediabunnyError)

    if (mediabunnyError.mediabunnyNoAudioTrack) {
      // A legitimately diagnosed case (this file genuinely has no audio
      // track) — surface it as-is instead of masking it behind the generic
      // "browser can't open this file" fallback message.
      throw mediabunnyError
    }

    // Mediabunny couldn't open/demux this file at all — fall back to the
    // browser's built-in (whole-file) decoder as a last resort.
    return decodeToMonoPCMWithAudioContext(blob)
  }
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
  const pcm = await decodeToMonoPCM(blob, (progress) => {
    onStatus?.({ phase: 'decoding', progress })
  })

  onStatus?.({ phase: 'transcribing' })
  const result = await transcriber(pcm, {
    language: 'thai',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  })

  return (result.text || '').trim()
}
