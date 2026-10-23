// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_AUTO_SEND_ATTRIBUTE, DICTATION_SUBMIT_EVENT } from './dictation-auto-send'

const store = vi.hoisted(() => ({
  state: {
    dictationState: 'stopping',
    settings: { voice: { enabled: true, autoSendAfterDictation: true, autoSendDelayMs: 1000 } },
    setPendingDictationAutoSend: (_pending: { deadline: number } | null) => {}
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (value: typeof store.state) => unknown) => selector(store.state),
    { getState: () => store.state }
  )
  return { useAppStore }
})

import { useDictationAutoSend } from './use-dictation-auto-send'

let submitted: HTMLElement[] = []
const recordSubmit = (event: Event): void => {
  if (event instanceof CustomEvent) {
    submitted.push(event.detail.element)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  submitted = []
  document.addEventListener(DICTATION_SUBMIT_EVENT, recordSubmit)
})

afterEach(() => {
  cleanup()
  document.removeEventListener(DICTATION_SUBMIT_EVENT, recordSubmit)
  document.body.replaceChildren()
  vi.useRealTimers()
})

function appendComposerEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.tabIndex = 0
  editor.setAttribute(DICTATION_AUTO_SEND_ATTRIBUTE, '')
  document.body.appendChild(editor)
  editor.focus()
  return editor
}

/**
 * Accepts Stop as the controller does and returns how the finish step reports the outcome. With
 * `duringStartup`, Stop lands while startup is still finishing, and the finish step comes later.
 */
function stopDictatingInto(editor: HTMLElement, duringStartup = false) {
  const { result } = renderHook(() => useDictationAutoSend())
  const target = { kind: 'contentEditable' as const, element: editor }
  if (duringStartup) {
    act(() => {
      result.current.watchStopping(target)
    })
  }
  return {
    finish: (outcome: Parameters<ReturnType<typeof result.current.watchStopping>>[0]) =>
      act(() => {
        const report = result.current.watchStopping(target)
        result.current.trackInsertion(Promise.resolve(true))
        report(outcome)
      })
  }
}

const SPOKEN = { finalTranscriptReceived: true, sessionErrored: false }

describe('useDictationAutoSend while a dictation is stopping', () => {
  it.each([
    ['after listening', false],
    ['during startup', true]
  ])('sends once the final transcript has landed, stopped %s', async (_name, duringStartup) => {
    const editor = appendComposerEditor()
    const stopping = stopDictatingInto(editor, duringStartup)

    stopping.finish(SPOKEN)
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([editor])
  })

  it('keeps the draft when the user types before the stopped event arrives', async () => {
    const editor = appendComposerEditor()
    const { result } = renderHook(() => useDictationAutoSend())
    let report: ReturnType<typeof result.current.watchStopping> = () => {}
    act(() => {
      report = result.current.watchStopping({ kind: 'contentEditable', element: editor })
      result.current.trackInsertion(Promise.resolve(true))
    })

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    act(() => report(SPOKEN))
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })

  it('keeps the draft when the user types while startup is still finishing after Stop', async () => {
    const editor = appendComposerEditor()
    const stopping = stopDictatingInto(editor, true)

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    stopping.finish(SPOKEN)
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })

  it.each([
    ['no speech was transcribed', { finalTranscriptReceived: false, sessionErrored: false }],
    ['the session errored', { finalTranscriptReceived: true, sessionErrored: true }]
  ])('sends nothing when %s', async (_name, result) => {
    const stopping = stopDictatingInto(appendComposerEditor())

    stopping.finish(result)
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })
})
