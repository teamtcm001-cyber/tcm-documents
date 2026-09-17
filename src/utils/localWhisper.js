// Fully client-side speech-to-text using a WASM-compiled Whisper model
// (@xenova/transformers) — no server call, no API key, no cost. The
// trade-off vs. a hosted GPU-backed Whisper API: slower (runs on the
// user's CPU via WASM) and less accurate, especially for Thai, since the
// model has to be small enough to run in a browser tab. Chosen anyway
// because the team doesn't want to attach a payment method to any AI
// provider for this feature.

// Default (current, unchanged) model. Accurate, but slower on long
// recordings. `whisper-tiny` is offered as an explicit opt-in for users who
// want faster turnaround on very long files and are OK with a small accuracy
// hit (see options.fast on transcribeLocally() below) — per tools-advisor
// research, multi-threading is not worth the site-wide COOP/COEP header risk
// to Supabase Storage links / the PDF.js CDN worker, so a smaller model is
// the only realistic speed lever available.
const DEFAULT_MODEL = 'Xenova/whisper-base'
const FAST_MODEL = 'Xenova/whisper-tiny'

// Resolves the { fast, model } shape used by both transcribeLocally() and
// checkResumableTranscription() into one concrete model id, so both call
// sites agree on what "the requested model" means.
function resolveModelName(options = {}) {
  if (options.model) return options.model
  return options.fast ? FAST_MODEL : DEFAULT_MODEL
}

// Keyed by model id so switching models mid-session (e.g. one file
// transcribed with `base`, another with `tiny`) reuses whichever pipeline is
// already cached instead of reloading it, and never cross-contaminates: a
// cached `tiny` pipeline is never handed back for a `base` request or vice
// versa.
const transcriberPromises = new Map()

function getTranscriber(onModelProgress, model = DEFAULT_MODEL) {
  if (!transcriberPromises.has(model)) {
    transcriberPromises.set(
      model,
      import('@xenova/transformers').then(({ pipeline, env }) => {
        // Without this, the library checks a local "/models/" path first — which
        // doesn't exist on this app's server, and a dev/prod SPA fallback returns
        // index.html for it, which then fails to parse as the JSON/model file it
        // expected. Force it straight to the Hugging Face Hub instead.
        env.allowLocalModels = false
        return pipeline('automatic-speech-recognition', model, {
          progress_callback: onModelProgress,
        })
      })
    )
  }
  return transcriberPromises.get(model)
}

// How much decoded audio to accumulate before resampling it down to 16kHz
// mono, transcribing it, and releasing the source-format buffers. This is
// what keeps both peak memory AND per-window transcribe latency bounded
// regardless of the recording's total length — a 3-4hr recording never
// exists as one giant PCM array or one giant transcribe() call, it's always
// processed (decode -> resample -> transcribe -> persist) one ~30s window
// at a time.
const DECODE_CHUNK_SECONDS = 30
const SAMPLE_RATE = 16000

// A few seconds of audio carried from the tail of one window into the next,
// so Whisper has a little context across the artificial chunk boundary —
// a cheap stand-in for the cross-chunk stride merge the library does
// internally when given one big buffer (chunk_length_s/stride_length_s).
// This is NOT a real cross-chunk merge: it can produce a few duplicated or
// dropped words right at chunk seams. That's an accepted tradeoff — this
// transcript feeds an AI/local MOM summarizer, not a verbatim subtitle
// track, so minor seam noise doesn't matter.
const OVERLAP_SECONDS = 3
const OVERLAP_SAMPLES = OVERLAP_SECONDS * SAMPLE_RATE

// ---------------------------------------------------------------------------
// IndexedDB-backed resume support (native API only, no idb/dexie/etc — kept
// dependency-free per project convention). Only ever stores per-chunk TEXT,
// never raw PCM audio: PCM is cheap to re-derive by re-decoding the original
// file from the resume point, and storing hours of PCM in IndexedDB would be
// gigabytes for no reason.
// ---------------------------------------------------------------------------

const IDB_NAME = 'tcm-mom-transcribe'
const IDB_VERSION = 1
const IDB_STORE = 'progress'

// Bumped whenever DECODE_CHUNK_SECONDS/OVERLAP_SECONDS (or anything else
// that affects what chunk index `i` means) changes. Resume correctness
// depends on chunk boundaries meaning the same thing in the run that saved
// progress and the run that resumes it — since this app can deploy a new
// version while a user has a multi-hour transcription sitting half-finished
// in a tab, a stored record whose schema version doesn't match the running
// code's is treated as non-resumable (discarded silently) rather than risk
// splicing text from the wrong time offset with no error.
const PROGRESS_SCHEMA_VERSION = 1

// How long an abandoned in-progress record is kept before being swept away,
// and a cap on how many records we keep around at all — otherwise a user who
// starts transcribing several files without ever finishing/discarding them
// would accumulate IndexedDB records forever.
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MAX_RECORDS = 5

function openProgressDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'fileKey' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// All IndexedDB helpers below fail soft (warn + no-op/null) — resume is a
// nice-to-have, it must never be the reason a transcription fails outright
// (e.g. in a private-browsing tab where IndexedDB is disabled).
async function idbGet(fileKey) {
  try {
    const db = await openProgressDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(fileKey)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('localWhisper: indexedDB read failed, resume disabled', e)
    return null
  }
}

async function idbPut(record) {
  try {
    const db = await openProgressDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('localWhisper: indexedDB write failed, resume disabled', e)
  }
}

async function idbDelete(fileKey) {
  try {
    const db = await openProgressDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(fileKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('localWhisper: indexedDB delete failed', e)
  }
}

async function idbGetAll() {
  try {
    const db = await openProgressDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('localWhisper: indexedDB getAll failed', e)
    return []
  }
}

// Best-effort cleanup for records left behind by abandoned transcriptions
// (user closed the tab, or started a different file without discarding the
// old one): removes anything older than RECORD_TTL_MS, and beyond that caps
// total stored records to the MAX_RECORDS most recently touched. Never
// throws — this is housekeeping, not something that should ever block an
// actual transcription.
async function sweepOldProgressRecords() {
  try {
    const records = await idbGetAll()
    if (records.length === 0) return
    const now = Date.now()
    const stale = new Set(records.filter((r) => now - (r.updatedAt || 0) > RECORD_TTL_MS).map((r) => r.fileKey))
    const fresh = records
      .filter((r) => !stale.has(r.fileKey))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const overflowKeys = fresh.slice(MAX_RECORDS).map((r) => r.fileKey)
    const toDelete = [...stale, ...overflowKeys]
    if (toDelete.length === 0) return
    const db = await openProgressDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)
      toDelete.forEach((key) => store.delete(key))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('localWhisper: sweep of old progress records failed', e)
  }
}

// Stable identity for a real uploaded File: name + size + lastModified +
// type is unique enough in practice for "did I already start transcribing
// this exact file" — not used for anything security sensitive.
//
// Plain Blobs (e.g. the in-memory MediaRecorder backup recording) do NOT
// carry name/lastModified, so falling back to a size/type-only key is a real
// collision risk: two different live-recorded meetings of similar length
// can land on the exact same key and silently splice one meeting's leftover
// chunk text into another's transcript. Callers that transcribe a plain
// Blob must pass an explicit, caller-generated `keyOverride` (e.g. a
// crypto.randomUUID() minted once when that recording session starts) —
// see MOMWriter.jsx's recordingSessionKeyRef.
function computeFileKey(blob, keyOverride) {
  if (keyOverride) return `override::${keyOverride}`
  const name = blob?.name || 'blob'
  const size = blob?.size ?? 0
  const lastModified = blob?.lastModified ?? 0
  const type = blob?.type || ''
  return `${name}::${size}::${lastModified}::${type}`
}

// Looks for a previously interrupted transcription of this exact file. If
// found, returns a small summary so the caller (MOMWriter) can ask the user
// whether to resume or start over. Returns null if there's nothing to
// resume from (never started, already completed, schema version stale, or
// indexedDB unavailable).
//
// `keyOverride` must be passed for plain-Blob sources (live recordings) —
// see computeFileKey().
// `options.fast`/`options.model` should match whatever will be passed to the
// eventual transcribeLocally() call, so a record left behind by a `base` run
// isn't offered as resumable for a `tiny` run (or vice versa) — see the
// model-mismatch check below.
export async function checkResumableTranscription(blob, keyOverride, options = {}) {
  sweepOldProgressRecords() // best-effort, not awaited — housekeeping only
  const fileKey = computeFileKey(blob, keyOverride)
  const record = await idbGet(fileKey)
  if (!record || record.completed || !Array.isArray(record.chunks)) return null
  const requestedModel = resolveModelName(options)
  const recordModel = record.model || DEFAULT_MODEL // older records predate this field — they're always `base`
  if (record.schemaVersion !== PROGRESS_SCHEMA_VERSION || recordModel !== requestedModel) {
    // Either the chunking scheme changed since this record was saved (e.g.
    // an app deploy landed while this recording sat half-transcribed in a
    // tab), or it was started with a different model than what's now being
    // requested (user flipped the fast-transcribe toggle between runs). In
    // both cases chunk `i`'s saved text may not be safe to splice into this
    // run — discard and treat as fresh rather than risk wrong text.
    await idbDelete(fileKey)
    return null
  }
  const chunksDone = record.chunks.filter((t) => typeof t === 'string').length
  if (chunksDone === 0) return null
  return {
    fileKey,
    chunksDone,
    approxSecondsDone: chunksDone * DECODE_CHUNK_SECONDS,
  }
}

// Explicitly discards a saved in-progress transcription (user chose "start
// over" instead of resuming).
export async function discardResumableTranscription(blob, keyOverride) {
  await idbDelete(computeFileKey(blob, keyOverride))
}

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// Resamples a single AudioBuffer (whatever its native sample rate/channel
// count) down to mono 16kHz using an OfflineAudioContext, same approach the
// whole-file path used before.
async function resampleBufferTo16kMono(audioBuffer) {
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * SAMPLE_RATE), SAMPLE_RATE)
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
// through the chunked decode/transcribe loop, once decoding has meaningfully
// started.
function markAsSetupFailure(error) {
  error.mediabunnySetupFailed = true
  return error
}

// ---------------------------------------------------------------------------
// Per-chunk decode -> transcribe -> persist -> report driver, shared by both
// decode paths below. Each call to processWindow() resamples one decoded
// window, feeds it to the (already-loaded) Whisper pipeline immediately,
// appends the resulting text, saves progress to IndexedDB, and reports
// streaming status (progress %, partial transcript, ETA) via onStatus.
// ---------------------------------------------------------------------------
function createChunkRunner({ transcriber, fileKey, resume, onStatus, model }) {
  let chunkIndex = 0
  let carry = null
  const texts = []
  let resumedTexts = new Map()
  let totalAudioSecondsProcessed = 0
  let totalProcessingMs = 0

  const init = async () => {
    if (resume) {
      const record = await idbGet(fileKey)
      const versionMatches = record && record.schemaVersion === PROGRESS_SCHEMA_VERSION
      const recordModel = record ? record.model || DEFAULT_MODEL : null
      const modelMatches = recordModel === model
      if (record && !record.completed && Array.isArray(record.chunks) && versionMatches && modelMatches) {
        record.chunks.forEach((text, i) => {
          if (typeof text === 'string') resumedTexts.set(i, text)
        })
      } else if (record && (!versionMatches || !modelMatches)) {
        // Stale schema (see PROGRESS_SCHEMA_VERSION), or saved by a different
        // model than the one being requested now (user flipped the
        // fast-transcribe toggle between the interrupted run and this
        // resume) — can't safely resume from it, discard rather than risk
        // splicing misaligned/mismatched text.
        await idbDelete(fileKey)
      }
    } else {
      await idbDelete(fileKey)
    }
  }

  const partialText = () =>
    texts
      .slice(0, chunkIndex)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

  // Processes one decoded window (a list of AudioBuffers covering
  // chunkAudioSeconds of NEW audio, i.e. not counting overlap).
  // decodedSoFarSeconds/totalDurationSeconds describe overall position in
  // the recording, used for progress/ETA reporting.
  const processWindow = async (buffers, chunkAudioSeconds, decodedSoFarSeconds, totalDurationSeconds) => {
    const index = chunkIndex
    chunkIndex += 1
    const totalChunks = totalDurationSeconds ? Math.ceil(totalDurationSeconds / DECODE_CHUNK_SECONDS) : undefined
    const baseProgress = totalDurationSeconds
      ? Math.min(100, Math.round((decodedSoFarSeconds / totalDurationSeconds) * 100))
      : undefined

    if (resumedTexts.has(index)) {
      // Already transcribed in a previous (interrupted) run — reuse the
      // saved text and skip the slow transcriber call entirely. Continuity
      // audio (carry) is lost across a skipped chunk; that only costs a
      // little context at this one seam.
      texts[index] = resumedTexts.get(index)
      carry = null
      onStatus?.({ phase: 'transcribing', progress: baseProgress, partialText: partialText(), chunkIndex: index, totalChunks })
      return
    }

    const merged = mergeAudioBuffers(buffers)
    const newPcm = await resampleBufferTo16kMono(merged)
    const windowPcm = carry ? concatFloat32(carry, newPcm) : newPcm

    onStatus?.({ phase: 'transcribing', progress: baseProgress, partialText: partialText(), chunkIndex: index, totalChunks })

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const result = await transcriber(windowPcm, {
      language: 'thai',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    const text = (result?.text || '').trim()
    texts[index] = text

    // Keep the tail of the NEW audio (not the whole window, so overlap
    // doesn't grow across many chunks) as context for the next window.
    carry = newPcm.length > OVERLAP_SAMPLES ? newPcm.slice(newPcm.length - OVERLAP_SAMPLES) : newPcm

    // Rate is (ms spent in transcriber()) / (seconds of audio actually fed
    // to transcriber() in that call). windowPcm includes the carried-over
    // overlap audio in addition to the new chunk, so the denominator must
    // use windowPcm's own duration — not chunkAudioSeconds (new audio only)
    // — otherwise the rate (and therefore the ETA shown to the user) comes
    // out inflated by roughly OVERLAP_SECONDS/DECODE_CHUNK_SECONDS (~10%).
    const windowSeconds = windowPcm.length / SAMPLE_RATE
    totalAudioSecondsProcessed += windowSeconds
    totalProcessingMs += elapsedMs
    const msPerAudioSecond = totalAudioSecondsProcessed > 0 ? totalProcessingMs / totalAudioSecondsProcessed : null
    const remainingSeconds = totalDurationSeconds ? Math.max(0, totalDurationSeconds - decodedSoFarSeconds) : null
    const etaSeconds =
      msPerAudioSecond != null && remainingSeconds != null ? Math.round((remainingSeconds * msPerAudioSecond) / 1000) : undefined

    // Persist progress after every chunk so an interrupted run (crash, tab
    // close, accidental navigation) can resume instead of starting a
    // multi-hour transcription over from scratch.
    await idbPut({ fileKey, chunks: texts.slice(), completed: false, schemaVersion: PROGRESS_SCHEMA_VERSION, model, updatedAt: Date.now() })

    onStatus?.({ phase: 'transcribing', progress: baseProgress, partialText: partialText(), etaSeconds, chunkIndex: index, totalChunks })
  }

  // Called once the whole recording has been processed successfully — marks
  // the saved progress complete/removed and returns the final joined text.
  const finish = async () => {
    await idbDelete(fileKey)
    return partialText()
  }

  return { init, processWindow, finish }
}

// Primary decode path: demux the container and decode the audio track via
// Mediabunny (which uses the native WebCodecs AudioDecoder under the hood),
// consuming decoded audio in small windows and transcribing each window
// immediately instead of asking the browser to decode the entire file into
// memory at once. This is what makes long (30min-4hr+) Zoom/Teams recordings
// work — decodeAudioData()'ing (or concatenating a whole recording's PCM)
// can be gigabytes and reliably fails/OOMs.
//
// Only failures during the initial open/demux (or the very first decoded
// buffer) are marked recoverable via markAsSetupFailure(): those genuinely
// mean Mediabunny couldn't read this file at all, so falling back to the
// whole-file decoder is reasonable. A failure later — including inside
// runner.processWindow(), e.g. a transcriber error — means decoding was
// working and something else went wrong; that must NOT silently fall back
// to a whole-file decode, since that's exactly the OOM failure mode this
// whole chunked approach exists to avoid. It's left unmarked so the caller
// lets it propagate as a real error instead.
async function transcribeWithMediabunny(blob, onStatus, runner) {
  const { ALL_FORMATS, BlobSource, Input, AudioBufferSink } = await import('mediabunny')

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      const noTrackError = markAsSetupFailure(new Error('mediabunny: no audio track found in file'))
      noTrackError.mediabunnyNoAudioTrack = true
      throw noTrackError
    }

    // Cheap, metadata-only duration lookup, used only to report progress/ETA.
    // If it's unavailable, we just skip those.
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

    let pending = []
    let pendingDuration = 0
    let decodedSoFar = 0
    let sawAnyAudio = false

    // From here on, errors are NOT marked as setup failures — they propagate
    // as-is so the caller does not fall back to the OOM-prone whole-file path.
    while (!next.done) {
      const { buffer, duration } = next.value
      pending.push(buffer)
      pendingDuration += duration
      decodedSoFar += duration
      sawAnyAudio = true
      if (totalDuration) {
        onStatus?.({ phase: 'decoding', progress: Math.min(100, Math.round((decodedSoFar / totalDuration) * 100)) })
      }
      if (pendingDuration >= DECODE_CHUNK_SECONDS) {
        const chunkAudioSeconds = pendingDuration
        const buffersForChunk = pending
        pending = []
        pendingDuration = 0
        await runner.processWindow(buffersForChunk, chunkAudioSeconds, decodedSoFar, totalDuration)
      }
      next = await iterator.next()
    }
    if (pending.length > 0) {
      await runner.processWindow(pending, pendingDuration, decodedSoFar, totalDuration)
    }

    if (!sawAnyAudio) {
      throw markAsSetupFailure(new Error('mediabunny: decoded no audio data'))
    }
  } finally {
    // Defensive cleanup: free the demuxer/source now rather than waiting on
    // GC, since this function may run repeatedly in one session.
    input.dispose?.()
  }
}

// Fallback decode path (whole file at once via the browser's built-in
// decoder). Used only when Mediabunny itself can't demux/read the file at
// all (e.g. a truly unsupported container) — not the primary path, since
// decoding a whole long recording at once is the approach that fails on
// long recordings. Even here, transcription is still done window-by-window
// (via the same runner) so progress/ETA/resume behave the same way.
async function transcribeWithAudioContext(blob, onStatus, runner) {
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

  const totalDuration = decoded.duration
  const chunkSamples = Math.round(DECODE_CHUNK_SECONDS * decoded.sampleRate)
  let offset = 0
  let decodedSoFar = 0

  while (offset < decoded.length) {
    const end = Math.min(offset + chunkSamples, decoded.length)
    const length = end - offset
    const windowBuffer = new AudioBuffer({ numberOfChannels: decoded.numberOfChannels, length, sampleRate: decoded.sampleRate })
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      windowBuffer.copyToChannel(decoded.getChannelData(ch).subarray(offset, end), ch, 0)
    }
    const chunkAudioSeconds = length / decoded.sampleRate
    decodedSoFar += chunkAudioSeconds
    onStatus?.({ phase: 'decoding', progress: Math.min(100, Math.round((decodedSoFar / totalDuration) * 100)) })
    await runner.processWindow([windowBuffer], chunkAudioSeconds, decodedSoFar, totalDuration)
    offset = end
  }
}

async function transcribeAudio(blob, onStatus, runner) {
  try {
    await transcribeWithMediabunny(blob, onStatus, runner)
  } catch (mediabunnyError) {
    if (!mediabunnyError?.mediabunnySetupFailed) {
      // Decoding had already started making progress when this happened —
      // falling back now would mean re-decoding the whole file at once,
      // which is the exact OOM-prone path this fix exists to avoid. Let it
      // surface as a real error instead of silently retrying (chunk
      // progress made so far stays saved in IndexedDB for a future resume).
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
    await transcribeWithAudioContext(blob, onStatus, runner)
  }
}

// onStatus receives a stream of status objects as transcription proceeds:
//   { phase: 'loading-model', progress?: number }   — first-run model download
//   { phase: 'decoding', progress?: number }         — decoding the current ~30s window
//   { phase: 'transcribing',
//     progress?: number,       // overall % of audio duration processed (0-100)
//     partialText?: string,    // transcript accumulated so far (updates per chunk)
//     etaSeconds?: number,     // estimated seconds remaining, from a running
//                               // chunkProcessingMs/chunkAudioSeconds average
//     chunkIndex?: number,     // 0-based index of the chunk just processed
//     totalChunks?: number,    // known only when the file's duration could be read
//   }
// `progress`/`totalChunks`/`etaSeconds` may be omitted if the recording's
// total duration couldn't be determined up front.
//
// options.resume (default true): if a previous interrupted transcription of
// this exact file is found in IndexedDB, reuse its saved chunk text instead
// of re-transcribing from the start. Pass { resume: false } to force a
// clean start (and discard any saved progress for this file).
// options.keyOverride: required for plain-Blob sources that don't carry
// stable name/lastModified (e.g. a live MediaRecorder backup recording) —
// see computeFileKey(). Not needed for real uploaded Files.
// options.fast (default false): use the smaller/faster `Xenova/whisper-tiny`
// model instead of the default `Xenova/whisper-base` — roughly 2x faster,
// meaningfully less accurate (especially for Thai), so it's an explicit
// opt-in surfaced as a toggle in MOMWriter, never a silent default.
// options.model: escape hatch to name an exact model id directly; takes
// precedence over options.fast if both are given. Most callers should just
// use options.fast.
export async function transcribeLocally(blob, onStatus, options = {}) {
  const { resume = true, keyOverride } = options
  const model = resolveModelName(options)

  sweepOldProgressRecords() // best-effort, not awaited — housekeeping only

  onStatus?.({ phase: 'loading-model', progress: 0 })
  const transcriber = await getTranscriber((p) => {
    if (p.status === 'progress') {
      onStatus?.({ phase: 'loading-model', progress: Math.round(p.progress || 0) })
    }
  }, model)

  const fileKey = computeFileKey(blob, keyOverride)
  const runner = createChunkRunner({ transcriber, fileKey, resume, onStatus, model })
  await runner.init()

  onStatus?.({ phase: 'decoding', progress: 0 })
  await transcribeAudio(blob, onStatus, runner)

  return runner.finish()
}
