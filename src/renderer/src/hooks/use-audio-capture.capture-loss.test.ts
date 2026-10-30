// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioCapture } from './use-audio-capture'

class FakeTrack extends EventTarget {
  stop = vi.fn()
}

type FakeAudioProcessor = {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null
}

function makeStream(track: FakeTrack): MediaStream {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream
}

function installAudioContext(): FakeAudioProcessor {
  const processor: FakeAudioProcessor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null
  }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      sampleRate = 48_000
      destination = {}
      createMediaStreamSource = vi.fn(() => source)
      createScriptProcessor = vi.fn(() => processor)
      resume = vi.fn(async () => undefined)
      close = vi.fn(async () => undefined)
    }
  )
  return processor
}

describe('useAudioCapture device loss', () => {
  let track: FakeTrack
  let processor: FakeAudioProcessor

  beforeEach(() => {
    track = new FakeTrack()
    processor = installAudioContext()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => makeStream(track)),
        enumerateDevices: vi.fn(async () => [
          { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in' }
        ])
      }
    })
    vi.stubGlobal('window', {
      ...globalThis.window,
      api: { speech: { feedAudio: vi.fn(async () => undefined) } }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports the device disappearing mid-capture', async () => {
    const onCaptureLost = vi.fn()
    const { result } = renderHook(() => useAudioCapture())

    await result.current.start({ microphoneDeviceId: 'mic-1', onCaptureLost })
    track.dispatchEvent(new Event('ended'))

    expect(onCaptureLost).toHaveBeenCalledTimes(1)
  })

  it('stays silent when we stopped capture ourselves', async () => {
    const onCaptureLost = vi.fn()
    const { result } = renderHook(() => useAudioCapture())

    await result.current.start({ microphoneDeviceId: 'mic-1', onCaptureLost })
    result.current.stop()
    track.dispatchEvent(new Event('ended'))

    expect(onCaptureLost).not.toHaveBeenCalled()
  })

  it('publishes the copied audio envelope without suppressing speech input', async () => {
    const publishMeter = vi.fn()
    const { result } = renderHook(() => useAudioCapture(publishMeter))
    await result.current.start({ sessionId: 'meter-session' })

    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(128).fill(0.3) }
    } as unknown as AudioProcessingEvent)

    expect(publishMeter).toHaveBeenLastCalledWith(
      expect.objectContaining({ isSpeaking: true, level: expect.any(Number) })
    )
    expect(window.api.speech.feedAudio).toHaveBeenCalledWith(
      expect.any(Float32Array),
      48_000,
      'meter-session'
    )
  })

  it('caps visual publications and deduplicates steady silence', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const publishMeter = vi.fn()
    const { result } = renderHook(() => useAudioCapture(publishMeter))
    await result.current.start()

    const process = (sample: number): void => {
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(128).fill(sample) }
      } as unknown as AudioProcessingEvent)
    }

    process(0)
    expect(publishMeter).toHaveBeenCalledTimes(1)

    now = 70
    process(0.3)
    now = 90
    process(0)
    expect(publishMeter).toHaveBeenCalledTimes(2)

    now = 140
    process(0)
    expect(publishMeter).toHaveBeenCalledTimes(3)
  })

  it('skips hidden updates, resumes promptly, and resets immediately on stop', async () => {
    let now = 0
    let hidden = true
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const publishMeter = vi.fn()
    const { result } = renderHook(() => useAudioCapture(publishMeter))
    await result.current.start()

    const process = (): void => {
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(128).fill(0.3) }
      } as unknown as AudioProcessingEvent)
    }

    process()
    expect(publishMeter).toHaveBeenCalledTimes(1)
    expect(window.api.speech.feedAudio).toHaveBeenCalledTimes(1)

    hidden = false
    now = 10
    process()
    expect(publishMeter).toHaveBeenCalledTimes(2)

    hidden = true
    now = 20
    result.current.stop()
    expect(publishMeter).toHaveBeenLastCalledWith({
      level: 0,
      isSpeaking: false,
      isClipping: false
    })
    expect(publishMeter).toHaveBeenCalledTimes(3)
  })
})
