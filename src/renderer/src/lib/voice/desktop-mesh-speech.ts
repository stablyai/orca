// Desktop speak-back playback — the half of the mobile voice feature that did
// NOT port for free.
//
// Mobile plays synthesized PCM through `@orca/expo-two-way-audio`'s
// `playPCMData`, a native module that does not exist on desktop. The renderer
// has Web Audio instead, so this decodes the same Kokoro PCM into an
// AudioBuffer and plays it. Unlike mobile there is no resample step: mobile
// downsamples 24 kHz → 16 kHz only because its playback path expects 16 kHz;
// Web Audio can play Kokoro's native 24 kHz directly.

import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_SAMPLE_RATE,
  KOKORO_TTS_MODEL,
  meshVoiceBaseUrlFor
} from './mesh-speech-config'

/** text → mesh Kokoro → raw 16-bit LE PCM at 24 kHz. */
export async function synthesizeViaMesh(
  text: string,
  options: { hostEndpoint?: string | null; signal?: AbortSignal } = {}
): Promise<ArrayBuffer> {
  const { hostEndpoint, signal } = options
  const res = await fetch(`${meshVoiceBaseUrlFor(hostEndpoint)}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: KOKORO_TTS_MODEL,
      input: text,
      voice: DEFAULT_KOKORO_VOICE,
      response_format: 'pcm'
    })
  })
  if (!res.ok) {
    throw new Error(`TTS ${res.status}`)
  }
  return res.arrayBuffer()
}

/** Convert 16-bit LE PCM into a mono AudioBuffer at the Kokoro sample rate. */
export function pcm16ToAudioBuffer(context: AudioContext, pcm: ArrayBuffer): AudioBuffer {
  const view = new DataView(pcm)
  const sampleCount = Math.floor(pcm.byteLength / 2)
  const buffer = context.createBuffer(1, sampleCount, KOKORO_SAMPLE_RATE)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < sampleCount; i++) {
    // 16-bit signed → float in [-1, 1).
    channel[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return buffer
}

/**
 * A single-utterance speaker. `speak` cancels any in-flight utterance first, so
 * a burst of finished turns does not overlap into noise — the newest reply wins,
 * matching how a person would interrupt themselves.
 */
export class DesktopMeshSpeaker {
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private abort: AbortController | null = null
  // Why: the host that owns the speak-back is the same Tailscale node the
  // voice routes to. Read on speak() and updated by the consumer so swapping
  // a paired device retargets synth without re-instantiating the speaker.
  private hostEndpoint: string | null = null

  setHostEndpoint(hostEndpoint: string | null | undefined): void {
    this.hostEndpoint = hostEndpoint ?? null
  }

  getHostEndpoint(): string | null {
    return this.hostEndpoint
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext()
    }
    return this.context
  }

  async speak(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) {
      return
    }
    this.stop()
    const controller = new AbortController()
    this.abort = controller
    const pcm = await synthesizeViaMesh(clean, { hostEndpoint: this.hostEndpoint, signal: controller.signal })
    if (controller.signal.aborted) {
      return
    }
    const context = this.ensureContext()
    // A context created before a user gesture can start suspended; resume is a
    // no-op when already running.
    if (context.state === 'suspended') {
      await context.resume()
    }
    const buffer = pcm16ToAudioBuffer(context, pcm)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    this.source = source
    source.start()
  }

  stop(): void {
    this.abort?.abort()
    this.abort = null
    if (this.source) {
      try {
        this.source.stop()
      } catch {
        // Already stopped or never started — nothing to do.
      }
      this.source = null
    }
  }
}
