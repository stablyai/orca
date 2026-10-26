// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElevenLabsAudioChunk } from '../../../../shared/speech-types'
import { playElevenLabsStream } from './elevenlabs-stream-playback'

class TestSource {
  buffer: { duration: number; samples: Float32Array } | null = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class TestContext {
  static instances: TestContext[] = []
  currentTime = 1
  destination = {}
  sources: TestSource[] = []
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  constructor() {
    TestContext.instances.push(this)
  }
  createBuffer(_channels: number, count: number, rate: number) {
    const samples = new Float32Array(count)
    return { duration: count / rate, samples, getChannelData: () => samples }
  }
  createBufferSource() {
    const source = new TestSource()
    this.sources.push(source)
    return source
  }
}

let emit: (event: ElevenLabsAudioChunk) => void
let finish: () => void
let rejectStream: (error: Error) => void
const unsubscribe = vi.fn()
const cancel = vi.fn(async () => {})
const stream = vi.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      finish = resolve
      rejectStream = reject
    })
)
const request = {
  requestId: 'live-1',
  text: '안녕하세요.',
  voiceId: 'test_voice',
  modelId: 'eleven_flash_v2_5'
} as const

beforeEach(() => {
  vi.clearAllMocks()
  TestContext.instances = []
  vi.stubGlobal('AudioContext', TestContext)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      speech: {
        streamElevenLabs: stream,
        onElevenLabsAudio: (listener: typeof emit) => {
          emit = listener
          return unsubscribe
        },
        cancelElevenLabs: cancel
      }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('streaming ElevenLabs playback', () => {
  it('plays before completion, joins split PCM samples and finishes after the last audio', async () => {
    const end = vi.fn()
    const error = vi.fn()
    playElevenLabsStream(request, end, error)
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    const context = TestContext.instances[0]
    emit({ requestId: 'another-window', bytes: new Uint8Array([0, 1]) })
    expect(context.sources).toHaveLength(0)
    emit({ requestId: request.requestId, bytes: new Uint8Array([0, 128, 255]) })
    expect(context.sources[0].buffer?.samples).toEqual(new Float32Array([-1]))
    expect(context.sources[0].start).toHaveBeenCalledWith(1.025)
    emit({ requestId: request.requestId, bytes: new Uint8Array([127]) })
    expect(context.sources[1].buffer?.samples[0]).toBeCloseTo(32767 / 32768)
    expect(context.sources[1].start).toHaveBeenCalledWith(1.025 + 1 / 24000)
    finish()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled())
    expect(end).not.toHaveBeenCalled()
    context.sources[0].onended?.()
    context.sources[1].onended?.()
    expect(end).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('cancels pending audio and ignores late chunks and completion', async () => {
    const end = vi.fn()
    const error = vi.fn()
    const stop = playElevenLabsStream(request, end, error)
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    emit({ requestId: request.requestId, bytes: new Uint8Array([0, 1]) })
    const context = TestContext.instances[0]
    stop()
    stop()
    emit({ requestId: request.requestId, bytes: new Uint8Array([0, 2]) })
    finish()
    await Promise.resolve()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].stop).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(request.requestId)
    expect(end).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not start a paid request if canceled while audio is opening', async () => {
    const stop = playElevenLabsStream(request, vi.fn(), vi.fn())
    stop()
    await Promise.resolve()
    expect(stream).not.toHaveBeenCalled()
    expect(TestContext.instances[0].close).toHaveBeenCalledOnce()
  })

  it('stops queued audio on a network error without retrying', async () => {
    const error = vi.fn()
    const end = vi.fn()
    playElevenLabsStream(request, end, error)
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
    emit({ requestId: request.requestId, bytes: new Uint8Array([0, 1]) })
    rejectStream(new Error('connection failed'))
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(TestContext.instances[0].sources[0].stop).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledOnce()
    expect(end).not.toHaveBeenCalled()
  })

  it.each([new Uint8Array(), new Uint8Array([0])])(
    'rejects empty or incomplete PCM',
    async (bytes) => {
      const error = vi.fn()
      playElevenLabsStream(request, vi.fn(), error)
      await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce())
      emit({ requestId: request.requestId, bytes })
      finish()
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    }
  )
})
