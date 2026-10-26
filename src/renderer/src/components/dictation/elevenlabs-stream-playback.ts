import type { ElevenLabsSpeechRequest } from '../../../../shared/speech-types'

const SAMPLE_RATE = 24000
const MAX_BYTES = 4 * 1024 * 1024

export function playElevenLabsStream(
  request: ElevenLabsSpeechRequest,
  onEnd: () => void,
  onError: () => void
): () => void {
  let stopped = false
  let finished = false
  let requested = false
  let received = 0
  let trailingByte: number | undefined
  let nextTime = 0
  let context: AudioContext | null = null
  let unsubscribe = () => {}
  const sources = new Set<AudioBufferSourceNode>()

  function cleanup(): void {
    unsubscribe()
    for (const source of sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    sources.clear()
    if (context) {
      void context.close().catch(() => undefined)
      context = null
    }
  }

  function cancel(): void {
    if (stopped) {
      return
    }
    stopped = true
    cleanup()
    if (requested && !finished) {
      void window.api.speech.cancelElevenLabs(request.requestId).catch(() => undefined)
    }
  }

  function fail(): void {
    if (stopped) {
      return
    }
    cancel()
    onError()
  }

  function complete(): void {
    if (stopped || !finished || sources.size) {
      return
    }
    stopped = true
    cleanup()
    onEnd()
  }

  function append(bytes: Uint8Array): void {
    if (stopped || finished || !context) {
      return
    }
    received += bytes.byteLength
    if (received > MAX_BYTES) {
      fail()
      return
    }
    const offset = trailingByte === undefined ? 0 : 1
    const pcm = new Uint8Array(bytes.length + offset)
    if (trailingByte !== undefined) {
      pcm[0] = trailingByte
    }
    pcm.set(bytes, offset)
    trailingByte = pcm.length % 2 ? pcm.at(-1) : undefined
    const count = Math.floor(pcm.length / 2)
    if (!count) {
      return
    }
    const buffer = context.createBuffer(1, count, SAMPLE_RATE)
    const samples = buffer.getChannelData(0)
    const view = new DataView(pcm.buffer)
    for (let i = 0; i < count; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      sources.delete(source)
      source.disconnect()
      complete()
    }
    nextTime = Math.max(nextTime, context.currentTime + 0.025)
    source.start(nextTime)
    sources.add(source)
    nextTime += buffer.duration
  }

  async function start(): Promise<void> {
    const { streamElevenLabs, onElevenLabsAudio } = window.api.speech
    if (!streamElevenLabs || !onElevenLabsAudio) {
      throw new Error('stream_unavailable')
    }
    context = new AudioContext({ latencyHint: 'interactive' })
    await context.resume()
    if (stopped) {
      return
    }
    unsubscribe = onElevenLabsAudio((chunk) => {
      if (chunk.requestId !== request.requestId) {
        return
      }
      try {
        append(new Uint8Array(chunk.bytes))
      } catch {
        fail()
      }
    })
    requested = true
    await streamElevenLabs(request)
    if (stopped) {
      return
    }
    if (!received || trailingByte !== undefined) {
      fail()
      return
    }
    finished = true
    unsubscribe()
    complete()
  }

  void start().catch(fail)
  return cancel
}
