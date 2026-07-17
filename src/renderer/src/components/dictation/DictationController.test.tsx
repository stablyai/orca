// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
  flushBufferedAudio: vi.fn(),
  discardBufferedAudio: vi.fn(),
  getCapturedChunkCount: vi.fn(() => 0),
  toastMessage: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/hooks/use-audio-capture', () => ({
  useAudioCapture: () => ({
    start: mocks.startCapture,
    stop: mocks.stopCapture,
    flushBufferedAudio: mocks.flushBufferedAudio,
    discardBufferedAudio: mocks.discardBufferedAudio,
    getCapturedChunkCount: mocks.getCapturedChunkCount
  })
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { message: mocks.toastMessage, error: vi.fn() })
}))
vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))
vi.mock('./dictation-insertion-target', () => ({
  captureInsertionTarget: vi.fn(() => null),
  insertText: vi.fn()
}))
vi.mock('./use-hold-dictation-gesture', () => ({ useHoldDictationGesture: vi.fn() }))

import { DictationController } from './DictationController'

let root: Root | null
let container: HTMLDivElement
let toggleDictation: (() => void) | undefined
let stoppedListener: ((data: { sessionId: string }) => void) | undefined
let state: Record<string, unknown>

function installApi(overrides?: {
  acquire?: () => Promise<{ active: true } | { active: false; reason: 'canceled' | 'unavailable' }>
  release?: () => Promise<void>
  calls?: string[]
}): void {
  const calls = overrides?.calls ?? []
  Object.assign(window, {
    api: {
      ui: {
        onDictationKeyDown: vi.fn((listener: () => void) => {
          toggleDictation = listener
          return () => {}
        })
      },
      speech: {
        acquirePlaybackSuppression: vi.fn(async () => {
          calls.push('acquire')
          return overrides?.acquire?.() ?? { active: true }
        }),
        releasePlaybackSuppression: vi.fn(async () => {
          calls.push('release')
          await overrides?.release?.()
        }),
        startDictation: vi.fn(async () => {
          calls.push('speech-start')
        }),
        stopDictation: vi.fn(async (sessionId: string) => {
          calls.push('speech-stop')
          stoppedListener?.({ sessionId })
        }),
        onPartialTranscript: vi.fn(() => () => {}),
        onFinalTranscript: vi.fn(() => () => {}),
        onStopped: vi.fn((listener) => {
          stoppedListener = listener
          return () => {}
        }),
        onError: vi.fn(() => () => {})
      }
    }
  })
}

async function renderController(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<DictationController />))
}

async function toggle(): Promise<void> {
  await act(async () => {
    toggleDictation?.()
    await Promise.resolve()
  })
}

beforeEach(() => {
  toggleDictation = undefined
  stoppedListener = undefined
  mocks.startCapture.mockImplementation(async () => undefined)
  mocks.startCapture.mockClear()
  mocks.stopCapture.mockClear()
  mocks.flushBufferedAudio.mockResolvedValue(undefined)
  mocks.discardBufferedAudio.mockClear()
  mocks.toastMessage.mockClear()
  state = {
    dictationState: 'idle',
    setDictationState: vi.fn((next) => {
      state.dictationState = next
    }),
    setPartialTranscript: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    settings: {
      voice: {
        enabled: true,
        sttModel: 'parakeet-test',
        dictationMode: 'toggle',
        muteSystemAudioDuringDictation: true
      }
    },
    keybindings: {}
  }
  mocks.useAppStore.mockImplementation((selector) => selector(state))
  Object.assign(mocks.useAppStore, { getState: () => state })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  vi.clearAllMocks()
})

describe('DictationController playback suppression', () => {
  it('mutes before capture and restores immediately when capture stops', async () => {
    const calls: string[] = []
    mocks.startCapture.mockImplementation(async () => {
      calls.push('capture-start')
    })
    mocks.stopCapture.mockImplementation(() => calls.push('capture-stop'))
    installApi({ calls })
    await renderController()

    await toggle()
    await vi.waitFor(() => expect(state.dictationState).toBe('listening'))
    await toggle()
    await vi.waitFor(() => expect(state.dictationState).toBe('idle'))

    expect(calls).toEqual([
      'acquire',
      'capture-start',
      'speech-start',
      'capture-stop',
      'release',
      'speech-stop'
    ])
  })

  it('continues dictation when playback suppression is unavailable', async () => {
    installApi({ acquire: async () => ({ active: false, reason: 'unavailable' }) })
    await renderController()

    await toggle()
    await vi.waitFor(() => expect(state.dictationState).toBe('listening'))

    expect(mocks.startCapture).toHaveBeenCalledTimes(1)
    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps existing capture behavior when the setting is disabled', async () => {
    const voice = (state.settings as { voice: { muteSystemAudioDuringDictation: boolean } }).voice
    voice.muteSystemAudioDuringDictation = false
    installApi()
    await renderController()

    await toggle()
    await vi.waitFor(() => expect(state.dictationState).toBe('listening'))

    expect(window.api.speech.acquirePlaybackSuppression).not.toHaveBeenCalled()
    expect(mocks.startCapture).toHaveBeenCalledTimes(1)
  })

  it('restores playback if the controller unmounts during dictation', async () => {
    installApi()
    await renderController()
    await toggle()
    await vi.waitFor(() => expect(state.dictationState).toBe('listening'))

    await act(async () => root?.unmount())
    root = null

    expect(window.api.speech.releasePlaybackSuppression).toHaveBeenCalledWith('1')
  })

  it('cancels a pending mute without starting microphone capture', async () => {
    let finishAcquire: ((result: { active: false; reason: 'canceled' }) => void) | undefined
    installApi({
      acquire: () =>
        new Promise((resolve) => {
          finishAcquire = resolve
        })
    })
    await renderController()

    await toggle()
    await vi.waitFor(() => expect(finishAcquire).toBeTypeOf('function'))
    await toggle()
    finishAcquire?.({ active: false, reason: 'canceled' })
    await vi.waitFor(() => expect(state.dictationState).toBe('idle'))

    expect(window.api.speech.releasePlaybackSuppression).toHaveBeenCalledWith('1')
    expect(mocks.startCapture).not.toHaveBeenCalled()
  })
})
