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

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/use-audio-capture', () => ({
  useAudioCapture: () => ({
    start: startCaptureMock,
    stop: stopCaptureMock,
    flushBufferedAudio: flushBufferedAudioMock,
    discardBufferedAudio: discardBufferedAudioMock,
    getCapturedChunkCount: () => 0
  })
}))

vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))
vi.mock('./use-hold-dictation-gesture', () => ({
  useHoldDictationGesture: useHoldDictationGestureMock
}))
vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(),
    message: vi.fn()
  })
  return { toast }
})
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

let root: Root | null = null
let dictationKeyHandler: (() => void) | null = null
let startDictationMock: ReturnType<typeof vi.fn>

function installWindowApi(): void {
  startDictationMock = vi.fn(async () => undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      speech: {
        startDictation: startDictationMock,
        stopDictation: vi.fn(async () => undefined),
        onPartialTranscript: vi.fn(() => () => undefined),
        onFinalTranscript: vi.fn(() => () => undefined),
        onStopped: vi.fn(() => () => undefined),
        onError: vi.fn(() => () => undefined)
      },
      ui: {
        onDictationKeyDown: vi.fn((callback: () => void) => {
          dictationKeyHandler = callback
          return () => undefined
        })
      }
    }
  })
}

function renderController(): void {
  const state = {
    dictationState: 'idle',
    setDictationState: vi.fn(),
    setPartialTranscript: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    settings: {
      voice: {
        ...getDefaultVoiceSettings(),
        enabled: true,
        sttModel: 'ready-model',
        customVocabulary: ['Orca', 'Qwen3-ASR', '中文术语']
      }
    },
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

describe('DictationController custom vocabulary', () => {
  beforeEach(() => {
    installWindowApi()
    startCaptureMock.mockClear()
    stopCaptureMock.mockClear()
    flushBufferedAudioMock.mockClear()
    discardBufferedAudioMock.mockClear()
    useAppStoreMock.mockReset()
    dictationKeyHandler = null
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('passes saved vocabulary to the speech start request', async () => {
    renderController()

    await act(async () => {
      dictationKeyHandler?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(startDictationMock).toHaveBeenCalledWith(
      'ready-model',
      ['Orca', 'Qwen3-ASR', '中文术语'],
      '1'
    )
  })
})
