// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armDictationAutoSend,
  DICTATION_AUTO_SEND_ATTRIBUTE,
  DICTATION_SUBMIT_EVENT,
  resolveDictationAutoSendDelayMs,
  resolveDictationAutoSendElement
} from './dictation-auto-send'

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
  document.removeEventListener(DICTATION_SUBMIT_EVENT, recordSubmit)
  document.body.replaceChildren()
  vi.useRealTimers()
})

/** The composer's prompt editor: a focused contenteditable that carries the marker itself. */
function appendComposerEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.tabIndex = 0
  editor.setAttribute(DICTATION_AUTO_SEND_ATTRIBUTE, '')
  document.body.appendChild(editor)
  editor.focus()
  return editor
}

function appendOtherButton(): HTMLButtonElement {
  const button = document.createElement('button')
  document.body.appendChild(button)
  return button
}

function deferredDelivery(): { promise: Promise<boolean>; resolve: (delivered: boolean) => void } {
  let resolve: (delivered: boolean) => void = () => {}
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function arm(editor: HTMLElement, delivered: Promise<boolean>, delayMs = 1000) {
  const onCountdown = vi.fn()
  const onSettled = vi.fn()
  const autoSend = armDictationAutoSend(editor, { delivered, delayMs, onCountdown, onSettled })
  return { autoSend, onCountdown, onSettled }
}

describe('armDictationAutoSend', () => {
  it('counts down only after delivery, then submits the editor', async () => {
    const editor = appendComposerEditor()
    const delivery = deferredDelivery()
    const { onCountdown, onSettled } = arm(editor, delivery.promise, 2000)

    await vi.advanceTimersByTimeAsync(5000)
    expect(onCountdown).not.toHaveBeenCalled()

    delivery.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onCountdown).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1999)
    expect(submitted).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(submitted).toEqual([editor])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('ignores the input events dictation fires while its text lands', async () => {
    const editor = appendComposerEditor()
    const delivery = deferredDelivery()
    arm(editor, delivery.promise)

    editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))
    delivery.resolve(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(submitted).toEqual([editor])
  })

  it.each([
    [
      'a key press',
      (editor: HTMLElement) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    ],
    ['a paste', (editor: HTMLElement) => editor.dispatchEvent(new Event('paste'))],
    [
      'focus leaving and coming back',
      (editor: HTMLElement) => {
        appendOtherButton().focus()
        editor.focus()
      }
    ]
  ])('does not send after %s while the text is still landing', async (_name, interrupt) => {
    const editor = appendComposerEditor()
    const delivery = deferredDelivery()
    const { onCountdown } = arm(editor, delivery.promise)

    interrupt(editor)
    delivery.resolve(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onCountdown).not.toHaveBeenCalled()
    expect(submitted).toEqual([])
  })

  it.each([
    [
      'a key press, including Enter',
      (editor: HTMLElement) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    ],
    ['an edit', (editor: HTMLElement) => editor.dispatchEvent(new InputEvent('input'))],
    ['focus leaving', () => appendOtherButton().focus()]
  ])('does not send after %s during the countdown', async (_name, interrupt) => {
    const editor = appendComposerEditor()
    const { onSettled } = arm(editor, Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(0)

    interrupt(editor)
    await vi.advanceTimersByTimeAsync(1000)

    expect(submitted).toEqual([])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('does not send when the text never reached the editor', async () => {
    const editor = appendComposerEditor()
    const { onCountdown, onSettled } = arm(editor, Promise.resolve(false))
    await vi.advanceTimersByTimeAsync(1000)

    expect(onCountdown).not.toHaveBeenCalled()
    expect(submitted).toEqual([])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('does not send when the editor lost focus before the text landed', async () => {
    const editor = appendComposerEditor()
    editor.blur()
    arm(editor, Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(1000)

    expect(submitted).toEqual([])
  })

  it('does not send after cancel, whether still landing or counting down', async () => {
    const landing = appendComposerEditor()
    const delivery = deferredDelivery()
    arm(landing, delivery.promise).autoSend.cancel()
    delivery.resolve(true)

    const counting = appendComposerEditor()
    const { autoSend } = arm(counting, Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(0)
    autoSend.cancel()
    await vi.advanceTimersByTimeAsync(1000)

    expect(submitted).toEqual([])
  })

  it('does not submit an editor removed before the delay ends', async () => {
    const editor = appendComposerEditor()
    arm(editor, Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(0)

    document.body.replaceChildren()
    await vi.advanceTimersByTimeAsync(1000)

    expect(submitted).toEqual([])
  })
})

describe('resolveDictationAutoSendElement', () => {
  const eligible = { enabled: true, finalTranscriptReceived: true, sessionErrored: false }

  it('returns the composer editor', () => {
    const editor = appendComposerEditor()
    expect(
      resolveDictationAutoSendElement({
        ...eligible,
        target: { kind: 'contentEditable', element: editor }
      })
    ).toBe(editor)
  })

  it.each([
    ['the setting is off', { enabled: false }],
    ['no speech was transcribed', { finalTranscriptReceived: false }],
    ['the session errored', { sessionErrored: true }]
  ])('skips when %s', (_name, override) => {
    const editor = appendComposerEditor()
    expect(
      resolveDictationAutoSendElement({
        ...eligible,
        ...override,
        target: { kind: 'contentEditable', element: editor }
      })
    ).toBeNull()
  })

  it('skips terminal panes and fields outside a chat composer', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(
      resolveDictationAutoSendElement({
        ...eligible,
        target: { kind: 'terminal', tabId: 'tab', paneId: 1 }
      })
    ).toBeNull()
    expect(
      resolveDictationAutoSendElement({ ...eligible, target: { kind: 'text', element: input } })
    ).toBeNull()
  })
})

describe('resolveDictationAutoSendDelayMs', () => {
  it('falls back to the default for values the picker does not offer', () => {
    expect(resolveDictationAutoSendDelayMs(3000)).toBe(3000)
    expect(resolveDictationAutoSendDelayMs(7000)).toBe(2000)
    expect(resolveDictationAutoSendDelayMs(undefined)).toBe(2000)
  })
})
