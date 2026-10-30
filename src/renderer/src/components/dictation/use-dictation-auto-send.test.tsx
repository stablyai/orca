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
  store.state.dictationState = 'stopping'
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

function watchStoppingInto(editor: HTMLElement) {
  const { result, rerender } = renderHook(() => useDictationAutoSend())
  const target = { kind: 'contentEditable' as const, element: editor }
  let report: ReturnType<typeof result.current.watchStopping> = () => {}
  act(() => {
    report = result.current.watchStopping(target)
    result.current.trackInsertion(Promise.resolve(true))
  })
  return { report, rerender, watchAgain: () => result.current.watchStopping(target) }
}

const SPOKEN = { finalTranscriptReceived: true, sessionErrored: false }

describe('useDictationAutoSend while a dictation is stopping', () => {
  it('sends once the final transcript has landed', async () => {
    const editor = appendComposerEditor()
    const { report } = watchStoppingInto(editor)

    act(() => report(SPOKEN))
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([editor])
  })

  it('reuses the first reporter on a repeated watchStopping call, keeping a takeover typed before it', async () => {
    const editor = appendComposerEditor()
    const { report, watchAgain } = watchStoppingInto(editor)

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    let repeated: typeof report = () => {}
    act(() => {
      repeated = watchAgain()
    })
    act(() => repeated(SPOKEN))
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(repeated).toBe(report)
    expect(submitted).toEqual([])
  })

  it.each([
    ['no speech was transcribed', { finalTranscriptReceived: false, sessionErrored: false }],
    ['the session errored', { finalTranscriptReceived: true, sessionErrored: true }]
  ])('sends nothing when %s', async (_name, outcome) => {
    const { report } = watchStoppingInto(appendComposerEditor())

    act(() => report(outcome))
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(submitted).toEqual([])
  })

  it('stops watching when dictation ends without reporting, as after a failed start', async () => {
    const setPending = vi.spyOn(store.state, 'setPendingDictationAutoSend')
    const { report, rerender } = watchStoppingInto(appendComposerEditor())

    store.state.dictationState = 'idle'
    rerender()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    act(() => report(SPOKEN))
    await act(async () => vi.advanceTimersByTimeAsync(1000))

    expect(setPending).toHaveBeenLastCalledWith(null)
    expect(submitted).toEqual([])
  })
})
