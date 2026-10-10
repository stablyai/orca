// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchDictationControl } from './dictation-control-events'

type SessionEvent = { sessionId: string; text?: string; error?: string }
type Listener = (data: SessionEvent) => void

const TARGET = { kind: 'terminal', tabId: 'tab-1', paneId: 1 } as const

const listeners = vi.hoisted(() => {
  const empty: Listener[] = []
  return { final: [...empty], error: [...empty], stopped: [...empty] }
})

const mocks = vi.hoisted(() => ({
  insertText: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn()
}))

const storeState = vi.hoisted(() => ({
  dictationState: 'idle',
  setDictationState: (state: string) => {
    storeState.dictationState = state
  },
  setPartialTranscript: () => {},
  recordFeatureInteraction: () => {},
  settings: { voice: { enabled: true, sttModel: 'gemini-2.5-flash', dictationMode: 'toggle' } },
  keybindings: {}
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('@/hooks/use-audio-capture', () => {
  const capture = {
    start: async () => ({ fellBackToDefaultMicrophone: false }),
    stop: () => {},
    flushBufferedAudio: async () => {},
    discardBufferedAudio: () => {},
    getCapturedChunkCount: () => 1
  }
  return { useAudioCapture: () => capture }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: mocks.toastError, message: mocks.toastMessage })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./dictation-insertion-target', () => ({
  captureInsertionTarget: () => TARGET,
  insertText: mocks.insertText
}))

vi.mock('./DictationIndicator', () => ({ DictationIndicator: () => null }))
vi.mock('./use-hold-dictation-gesture', () => ({ useHoldDictationGesture: () => {} }))

import { DictationController } from './DictationController'

function emit(kind: keyof typeof listeners, data: SessionEvent): void {
  for (const listener of listeners[kind]) {
    listener(data)
  }
}

function subscribe(kind: keyof typeof listeners) {
  return (listener: Listener) => {
    listeners[kind].push(listener)
    return () => {
      listeners[kind] = listeners[kind].filter((entry) => entry !== listener)
    }
  }
}

const stopDictation = vi.fn<(sessionId: string) => Promise<void>>()

beforeEach(() => {
  storeState.dictationState = 'idle'
  mocks.insertText.mockReset()
  mocks.toastError.mockReset()
  stopDictation.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      speech: {
        startDictation: vi.fn(async () => {}),
        stopDictation,
        onPartialTranscript: () => () => {},
        onFinalTranscript: subscribe('final'),
        onStopped: subscribe('stopped'),
        onError: subscribe('error')
      },
      ui: { onDictationKeyDown: () => () => {} }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DictationController after a dictation error', () => {
  it('still inserts the final transcript the stop delivers for the failed session', async () => {
    render(<DictationController />)
    await act(async () => {
      dispatchDictationControl('start')
    })
    expect(storeState.dictationState).toBe('listening')
    stopDictation.mockImplementation(async (sessionId) => {
      emit('final', { sessionId, text: 'Words before the limit.' })
      emit('stopped', { sessionId })
    })

    await act(async () => {
      emit('error', { sessionId: '1', error: 'Gemini dictation is limited to 7 minutes.' })
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledWith('1')
    expect(mocks.insertText).toHaveBeenCalledWith('Words before the limit.', TARGET)
    expect(storeState.dictationState).toBe('idle')
  })

  it('ignores a late final for the failed session once it has stopped', async () => {
    render(<DictationController />)
    await act(async () => {
      dispatchDictationControl('start')
    })
    stopDictation.mockImplementation(async (sessionId) => {
      emit('stopped', { sessionId })
    })
    await act(async () => {
      emit('error', { sessionId: '1', error: 'boom' })
    })

    emit('final', { sessionId: '1', text: 'Too late.' })

    expect(mocks.insertText).not.toHaveBeenCalled()
  })

  it('keeps a dictation started right after an error during the stop flush', async () => {
    vi.useFakeTimers()
    render(<DictationController />)
    await act(async () => {
      dispatchDictationControl('start')
    })
    let firstStop = true
    stopDictation.mockImplementation(async (sessionId) => {
      if (sessionId === '1' && firstStop) {
        firstStop = false
        emit('error', { sessionId, error: 'Provider failed during flush.' })
        return
      }
      emit('stopped', { sessionId })
    })

    await act(async () => {
      dispatchDictationControl('stop')
    })
    expect(storeState.dictationState).toBe('idle')

    stopDictation.mockImplementation(async () => {})
    await act(async () => {
      dispatchDictationControl('start')
    })
    expect(storeState.dictationState).toBe('listening')
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(storeState.dictationState).toBe('listening')
    emit('final', { sessionId: '3', text: 'Second run.' })
    expect(mocks.insertText).toHaveBeenCalledWith('Second run.', TARGET)
  })

  it('keeps the insertion target for a final salvaged while startup is still running', async () => {
    let finishStartup: () => void = () => {}
    window.api.speech.startDictation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStartup = resolve
        })
    )
    stopDictation.mockImplementation(async (sessionId) => {
      emit('stopped', { sessionId })
    })
    render(<DictationController />)
    await act(async () => {
      dispatchDictationControl('start')
    })
    let releaseSalvageStop: () => void = () => {}
    stopDictation.mockImplementationOnce(
      (sessionId) =>
        new Promise<void>((resolve) => {
          releaseSalvageStop = () => {
            emit('final', { sessionId, text: 'Salvaged words.' })
            emit('stopped', { sessionId })
            resolve()
          }
        })
    )

    await act(async () => {
      emit('error', { sessionId: '1', error: 'boom' })
    })
    await act(async () => {
      finishStartup()
    })
    await act(async () => {
      releaseSalvageStop()
    })

    expect(mocks.insertText).toHaveBeenCalledWith('Salvaged words.', TARGET)
    expect(mocks.toastMessage).not.toHaveBeenCalledWith(
      'Dictation finished, but no text field was focused.'
    )
  })
})
