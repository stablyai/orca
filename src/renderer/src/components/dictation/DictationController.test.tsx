// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { DictationController } from './DictationController'
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const {
  startCaptureMock,
  stopCaptureMock,
  flushBufferedAudioMock,
  discardBufferedAudioMock,
  useAppStoreMock,
  useHoldDictationGestureMock
} = vi.hoisted(() => ({
  startCaptureMock: vi.fn(async () => undefined),
  stopCaptureMock: vi.fn(),
  flushBufferedAudioMock: vi.fn(async () => undefined),
  discardBufferedAudioMock: vi.fn(),
  useAppStoreMock: vi.fn(),
  useHoldDictationGestureMock: vi.fn()
}))

type DictationKeyHandler = () => void
type SpeechErrorHandler = (data: { sessionId: string; error: string }) => void
type SpeechStoppedHandler = (data: { sessionId: string }) => void

type TestApi = {
  dictationOutput: {
    apply: ReturnlessAsyncMock
    restore: ReturnlessAsyncMock
  }
  speech: {
    startDictation: ReturnlessAsyncMock
    stopDictation: ReturnlessAsyncMock
    onPartialTranscript: (callback: unknown) => () => void
    onFinalTranscript: (callback: unknown) => () => void
    onStopped: (callback: SpeechStoppedHandler) => () => void
    onError: (callback: SpeechErrorHandler) => () => void
  }
  ui: {
    onDictationKeyDown: (callback: DictationKeyHandler) => () => void
  }
}

type ReturnlessAsyncMock = ReturnlessMock & ((...args: unknown[]) => Promise<void>)
type ReturnlessMock = { mock: { invocationCallOrder: number[] } }

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/use-audio-capture', () => ({
  useAudioCapture: () => ({
    start: startCaptureMock,
    stop: stopCaptureMock,
    flushBufferedAudio: flushBufferedAudioMock,
    discardBufferedAudio: discardBufferedAudioMock,
    getCapturedChunkCount: () => 0,
    getRecoveryAudioChunks: () => [],
    clearRecoveryAudio: vi.fn()
  })
}))

vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))
vi.mock('./use-hold-dictation-gesture', () => ({
  useHoldDictationGesture: useHoldDictationGestureMock
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace('{{value0}}', values.value0) : fallback
}))

let root: Root | null = null
let dictationKeyHandler: DictationKeyHandler | null = null
let speechErrorHandler: SpeechErrorHandler | null = null
let speechStoppedHandler: SpeechStoppedHandler | null = null
let api: TestApi

function installApi(): void {
  api = {
    dictationOutput: {
      apply: vi.fn(async () => undefined) as unknown as ReturnlessAsyncMock,
      restore: vi.fn(async () => undefined) as unknown as ReturnlessAsyncMock
    },
    speech: {
      startDictation: vi.fn(async () => undefined) as unknown as ReturnlessAsyncMock,
      stopDictation: vi.fn(async () => undefined) as unknown as ReturnlessAsyncMock,
      onPartialTranscript: vi.fn(() => () => undefined),
      onFinalTranscript: vi.fn(() => () => undefined),
      onStopped: vi.fn((callback: SpeechStoppedHandler) => {
        speechStoppedHandler = callback
        return () => undefined
      }),
      onError: vi.fn((callback: SpeechErrorHandler) => {
        speechErrorHandler = callback
        return () => undefined
      })
    },
    ui: {
      onDictationKeyDown: vi.fn((callback: DictationKeyHandler) => {
        dictationKeyHandler = callback
        return () => undefined
      })
    }
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

function renderController(): void {
  const settings = {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: true,
      sttModel: 'ready-model',
      outputVolumeMode: 'duck',
      duckedVolumePercent: 20
    }
  }
  const state = {
    dictationState: 'idle',
    setDictationState: vi.fn(),
    setPartialTranscript: vi.fn(),
    resetDictationMeter: vi.fn(),
    setDictationNotice: vi.fn(),
    clearDictationNotice: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    settings,
    keybindings: []
  }
  useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) =>
    selector(state)
  )
  Object.assign(useAppStoreMock, {
    getState: vi.fn(() => ({ openSettingsTarget: vi.fn(), openSettingsPage: vi.fn() }))
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<DictationController />)
  })
}

async function startDictationFromShortcut(): Promise<void> {
  await act(async () => {
    dictationKeyHandler?.()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('DictationController output control', () => {
  beforeEach(() => {
    installApi()
    startCaptureMock.mockClear()
    stopCaptureMock.mockClear()
    flushBufferedAudioMock.mockClear()
    discardBufferedAudioMock.mockClear()
    useAppStoreMock.mockReset()
    dictationKeyHandler = null
    speechErrorHandler = null
    speechStoppedHandler = null
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('applies output control once before starting capture', async () => {
    renderController()

    await startDictationFromShortcut()

    expect(api.dictationOutput.apply).toHaveBeenCalledWith('1', {
      pauseMedia: false,
      volumeMode: 'duck',
      duckedVolumePercent: 20
    })
    expect(api.dictationOutput.apply.mock.invocationCallOrder[0]).toBeLessThan(
      startCaptureMock.mock.invocationCallOrder[0]
    )
  })

  it('restores output control after a speech error path stops the session', async () => {
    renderController()
    await startDictationFromShortcut()

    await act(async () => {
      speechErrorHandler?.({ sessionId: '1', error: 'worker failed' })
      await Promise.resolve()
      speechStoppedHandler?.({ sessionId: '1' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.speech.stopDictation).toHaveBeenCalledWith('1')
    expect(api.dictationOutput.restore).toHaveBeenCalledWith('1')
  })
})
