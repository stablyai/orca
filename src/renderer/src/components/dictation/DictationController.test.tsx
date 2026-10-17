// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationState } from '../../../../shared/speech-types'
import { DICTATION_CONTROL_EVENT } from './dictation-control-events'

const storeState = {
  dictationState: 'idle' satisfies DictationState,
  settings: {
    voice: { enabled: true, sttModel: 'model-a', dictationMode: 'toggle' }
  },
  keybindings: {},
  setDictationState: vi.fn<(state: DictationState) => void>(),
  setPartialTranscript: vi.fn<(text: string) => void>(),
  recordFeatureInteraction: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('@/hooks/use-audio-capture', () => ({
  useAudioCapture: () => ({
    start: vi.fn().mockResolvedValue({ fellBackToDefaultMicrophone: false }),
    stop: vi.fn(),
    flushBufferedAudio: vi.fn().mockResolvedValue(undefined),
    discardBufferedAudio: vi.fn(),
    getCapturedChunkCount: vi.fn().mockReturnValue(0)
  })
}))
vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))
vi.mock('./use-hold-dictation-gesture', () => ({ useHoldDictationGesture: vi.fn() }))
vi.mock('./dictation-meter-store', () => ({ publishDictationMeter: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/dictation/dictation-start-error-toast', () => ({
  showDictationStartErrorToast: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

type SpeechListener = (data: {
  sessionId: string
  text?: string
  error?: string
  recoverable?: boolean
}) => void
const listeners = new Map<string, SpeechListener[]>()
const speechApi = {
  startDictation: vi.fn().mockResolvedValue(undefined),
  stopDictation: vi.fn().mockResolvedValue(undefined),
  onPartialTranscript: (listener: SpeechListener) => subscribe('partial', listener),
  onFinalTranscript: (listener: SpeechListener) => subscribe('final', listener),
  onStopped: (listener: SpeechListener) => subscribe('stopped', listener),
  onError: (listener: SpeechListener) => subscribe('error', listener),
  onReady: () => () => {},
  onDownloadProgress: () => () => {}
}

function subscribe(kind: string, listener: SpeechListener): () => void {
  const current = listeners.get(kind) ?? []
  current.push(listener)
  listeners.set(kind, current)
  return () =>
    listeners.set(
      kind,
      current.filter((candidate) => candidate !== listener)
    )
}

function emit(kind: string, data: Parameters<SpeechListener>[0]): void {
  for (const listener of listeners.get(kind) ?? []) {
    listener(data)
  }
}

import { DictationController } from './DictationController'

const insertionListeners: EventListener[] = []

function recordInsertion(insertions: unknown[]): void {
  const listener: EventListener = (event) => {
    if (event instanceof CustomEvent) {
      insertions.push(event.detail)
    }
  }
  insertionListeners.push(listener)
  document.addEventListener('dictation:insertText', listener)
}

beforeEach(() => {
  listeners.clear()
  storeState.dictationState = 'idle'
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { speech: speechApi, ui: { onDictationKeyDown: () => () => {} } }
  })
})

afterEach(() => {
  for (const listener of insertionListeners) {
    document.removeEventListener('dictation:insertText', listener)
  }
  insertionListeners.length = 0
  cleanup()
  document.body.innerHTML = ''
})

async function startWithTerminalTarget(): Promise<void> {
  const tab = document.createElement('div')
  tab.dataset.terminalTabId = 'tab-1'
  const pane = document.createElement('div')
  pane.className = 'pane'
  pane.dataset.paneId = '3'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  pane.append(textarea)
  tab.append(pane)
  document.body.append(tab)
  textarea.focus()
  render(<DictationController />)
  await act(async () => {
    document.dispatchEvent(new CustomEvent(DICTATION_CONTROL_EVENT, { detail: 'start' }))
    await Promise.resolve()
  })
}

describe('DictationController overload recovery', () => {
  it('inserts finals from accepted audio before a recoverable overload stops the session', async () => {
    const insertions: unknown[] = []
    recordInsertion(insertions)
    await startWithTerminalTarget()

    act(() => emit('error', { sessionId: '1', error: 'queue full', recoverable: true }))
    act(() => emit('final', { sessionId: '1', text: 'accepted speech' }))
    act(() => emit('stopped', { sessionId: '1' }))
    act(() => emit('final', { sessionId: '1', text: 'late speech' }))

    expect(insertions).toEqual([{ text: 'accepted speech', tabId: 'tab-1', paneId: 3 }])
    expect(speechApi.stopDictation).toHaveBeenCalledWith('1')
  })

  it('still rejects finals after a permanent recognizer error', async () => {
    const insertions: unknown[] = []
    recordInsertion(insertions)
    await startWithTerminalTarget()

    act(() => emit('error', { sessionId: '1', error: 'native failure' }))
    act(() => emit('final', { sessionId: '1', text: 'must be ignored' }))
    act(() => emit('stopped', { sessionId: '1' }))

    expect(insertions).toEqual([])
    expect(speechApi.stopDictation).toHaveBeenCalledWith('1')
  })
})
