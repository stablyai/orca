/**
 * Local voice-activity gate on the mic sender: the provider bills per streamed audio
 * minute, silence included, so the mic track only reaches the peer connection while the
 * user is actually speaking. Gate close is normally signalled by the server's
 * `input_audio_buffer.committed`; a fallback timer covers speech the server VAD declined
 * to commit.
 */

export type VoiceActivityGate = {
  /** True while mic audio is flowing to the provider. */
  readonly open: boolean
  /** Mute force-closes the gate and pauses the VAD engine; unmute resumes listening (gate stays closed until speech). */
  setMuted: (muted: boolean) => void
  /** Feed server events: call when `input_audio_buffer.committed` arrives. */
  notifyServerCommit: () => void
  dispose: () => void
}

/** The narrowest slice of RTCRtpSender the gate touches (sender.track flips to null once gated). */
export type VoiceGateSender<Track> = {
  replaceTrack: (track: Track | null) => Promise<void>
}

/** Structural subset of vad-web's MicVAD so tests can inject a fake. */
export type VoiceGateEngine = {
  start: () => unknown
  pause: () => unknown
  destroy: () => unknown
}

export type VoiceGateEngineCallbacks = {
  onSpeechStart: () => void
  onSpeechEnd: () => void
  onVADMisfire: () => void
}

export type CreateVoiceActivityGateOptions<Track> = {
  sender: VoiceGateSender<Track>
  track: Track
  stream: MediaStream
  isMuted: () => boolean
  createEngine?: (callbacks: VoiceGateEngineCallbacks) => Promise<VoiceGateEngine>
}

/** Covers speech the server VAD declined to commit; the committed event is the normal close. */
const FALLBACK_CLOSE_MS = 2_500

async function createMicVadEngine(
  stream: MediaStream,
  callbacks: VoiceGateEngineCallbacks
): Promise<VoiceGateEngine> {
  // Lazy: the model + onnx WASM are ~2MB and unit tests must never touch onnx.
  const { MicVAD } = await import('@ricky0123/vad-web')
  const assetBase = new URL('vad/', document.baseURI).href
  return MicVAD.new({
    // v5 is the documented stable Silero model; v6 is newer but less battle-tested.
    model: 'v5',
    baseAssetPath: assetBase,
    onnxWASMBasePath: assetBase,
    // The Electron renderer is not cross-origin-isolated, so SharedArrayBuffer
    // threading is unavailable to onnxruntime.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1
    },
    // ScriptProcessor over AudioWorklet: the worklet would need its bundle served as a
    // third asset, and a file:// worklet load in the packaged app is unverified.
    processorType: 'ScriptProcessor',
    // The session owns the mic stream — vad-web must never call getUserMedia or stop tracks.
    getStream: async () => stream,
    resumeStream: async () => stream,
    pauseStream: async () => {},
    startOnLoad: true,
    submitUserSpeechOnPause: false,
    onSpeechStart: callbacks.onSpeechStart,
    onSpeechEnd: () => callbacks.onSpeechEnd(),
    onVADMisfire: callbacks.onVADMisfire
  })
}

function swallowEngineResult(result: unknown): void {
  void Promise.resolve(result).catch(() => {})
}

export async function createVoiceActivityGate<Track>(
  options: CreateVoiceActivityGateOptions<Track>
): Promise<VoiceActivityGate> {
  let open = false
  let muted = options.isMuted()
  let speechActive = false
  let disposed = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const cancelCloseTimer = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  const openGate = (): void => {
    if (open || disposed) {
      return
    }
    open = true
    swallowEngineResult(options.sender.replaceTrack(options.track))
  }

  const closeGate = (): void => {
    if (!open) {
      return
    }
    open = false
    swallowEngineResult(options.sender.replaceTrack(null))
  }

  const engine = await (options.createEngine ?? ((callbacks) => createMicVadEngine(options.stream, callbacks)))({
    onSpeechStart: () => {
      if (disposed) {
        return
      }
      speechActive = true
      // A fallback timer from a segment the server declined must not close the gate
      // under a new segment the server may still commit.
      cancelCloseTimer()
      if (!muted) {
        openGate()
      }
    },
    onSpeechEnd: () => {
      if (disposed) {
        return
      }
      speechActive = false
      cancelCloseTimer()
      // The normal close is the server's input_audio_buffer.committed — it fires exactly
      // when the provider has the whole turn (no tuned hangover, no clipped short
      // utterances); this timer only covers speech the server VAD declined to commit.
      closeTimer = setTimeout(() => {
        closeTimer = null
        closeGate()
      }, FALLBACK_CLOSE_MS)
    },
    onVADMisfire: () => {
      if (disposed) {
        return
      }
      // Shorter than minSpeechMs: the server never sees a turn, so no commit is coming.
      speechActive = false
      closeGate()
    }
  })

  // Physically start closed — the sender still carries the mic track from addTrack. If
  // this fails the caller degrades to ungated, so the just-created engine must not leak.
  try {
    await options.sender.replaceTrack(null)
  } catch (error) {
    try {
      swallowEngineResult(engine.destroy())
    } catch {
      // destroy failures must not mask the replaceTrack failure the caller degrades on.
    }
    throw error
  }
  if (muted) {
    swallowEngineResult(engine.pause())
  }

  return {
    get open() {
      return open
    },
    setMuted: (next: boolean) => {
      if (disposed || muted === next) {
        return
      }
      muted = next
      if (next) {
        cancelCloseTimer()
        closeGate()
        swallowEngineResult(engine.pause())
      } else {
        swallowEngineResult(engine.start())
      }
    },
    notifyServerCommit: () => {
      if (disposed) {
        return
      }
      // Speech active means the user re-started before this commit landed; the commit
      // covers the earlier segment and the gate stays open for the new one.
      cancelCloseTimer()
      if (!speechActive) {
        closeGate()
      }
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      cancelCloseTimer()
      try {
        swallowEngineResult(engine.destroy())
      } catch {
        // dispose never throws.
      }
    }
  }
}
