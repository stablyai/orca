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

import { useDictationAutoSend, type DictationSessionOutcome } from './use-dictation-auto-send'

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

/** Starts watching as the controller does when stopping begins, with the outcome still unknown. */
function stopDictatingInto(editor: HTMLElement) {
  const { result } = renderHook(() => useDictationAutoSend())
  const outcome = Promise.withResolvers<DictationSessionOutcome>()
  act(() => {
    result.current.startWhenStopping({ kind: 'contentEditable', element: editor }, outcome.promise)
    result.current.trackInsertion(Promise.resolve(true))
  })
  return outcome
}

describe('useDictationAutoSend while a dictation is stopping', () => {
  it('sends once the final transcript has landed', async () => {
    const editor = appendComposerEditor()
    const outcome = stopDictatingInto(editor)

    outcome.resolve({ finalTranscriptReceived: true, sessionErrored: false })
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([editor])
  })

  it('keeps the draft when the user types before the final transcript arrives', async () => {
    const editor = appendComposerEditor()
    const outcome = stopDictatingInto(editor)

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    outcome.resolve({ finalTranscriptReceived: true, sessionErrored: false })
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })

  it.each([
    ['no speech was transcribed', { finalTranscriptReceived: false, sessionErrored: false }],
    ['the session errored', { finalTranscriptReceived: true, sessionErrored: true }]
  ])('sends nothing when %s', async (_name, result) => {
    const outcome = stopDictatingInto(appendComposerEditor())

    outcome.resolve(result)
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })
})
