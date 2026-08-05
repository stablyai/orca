// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioCapture } from './use-audio-capture'

class FakeTrack extends EventTarget {
  stop = vi.fn()
}

function makeStream(track: FakeTrack): MediaStream {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream
}

function installAudioContext(): void {
  const processor = {
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
}

describe('useAudioCapture device loss', () => {
  let track: FakeTrack

  beforeEach(() => {
    track = new FakeTrack()
    installAudioContext()
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
})
