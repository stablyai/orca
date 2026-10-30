import { describe, expect, it } from 'vitest'
import {
  firesNativePasteEvent,
  getClipboardEventText,
  shouldUseClipboardEventPaste
} from './terminal-clipboard-event-paste'

type KeyEventFields = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

function makeKeyEvent(overrides: Partial<KeyEventFields>): KeyEventFields {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

function makeClipboardEvent(text: string | null): ClipboardEvent {
  return {
    clipboardData:
      text === null
        ? null
        : {
            getData: (type: string) => (type === 'text/plain' ? text : '')
          }
  } as unknown as ClipboardEvent
}

describe('shouldUseClipboardEventPaste', () => {
  it('requires the fallback for web clients without navigator.clipboard.readText', () => {
    expect(
      shouldUseClipboardEventPaste({ isWebClient: true, clipboardReadTextAvailable: false })
    ).toBe(true)
  })

  it('keeps async clipboard reads for secure-context web clients', () => {
    expect(
      shouldUseClipboardEventPaste({ isWebClient: true, clipboardReadTextAvailable: true })
    ).toBe(false)
  })

  it('never applies to the Electron renderer, which reads the clipboard over IPC', () => {
    expect(
      shouldUseClipboardEventPaste({ isWebClient: false, clipboardReadTextAvailable: false })
    ).toBe(false)
    expect(
      shouldUseClipboardEventPaste({ isWebClient: false, clipboardReadTextAvailable: true })
    ).toBe(false)
  })
})

describe('getClipboardEventText', () => {
  it('reads text/plain from the event clipboardData', () => {
    expect(getClipboardEventText(makeClipboardEvent('echo hi'))).toBe('echo hi')
  })

  it('returns empty text when clipboardData is missing', () => {
    expect(getClipboardEventText(makeClipboardEvent(null))).toBe('')
  })
})

describe('firesNativePasteEvent', () => {
  it('recognizes the default native paste chords on macOS', () => {
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'v', metaKey: true }), true)).toBe(true)
  })

  it('recognizes the default native paste chords on Windows/Linux', () => {
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'v', ctrlKey: true }), false)).toBe(true)
    // Ctrl+Shift+V is the default terminal paste and still dispatches a native event.
    expect(
      firesNativePasteEvent(makeKeyEvent({ key: 'v', ctrlKey: true, shiftKey: true }), false)
    ).toBe(true)
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'Insert', shiftKey: true }), false)).toBe(true)
  })

  it('recognizes Ctrl+V on a non-Latin layout by its physical key', () => {
    expect(
      firesNativePasteEvent(makeKeyEvent({ key: 'м', code: 'KeyV', ctrlKey: true }), false)
    ).toBe(true)
  })

  it('does not treat a remapped non-clipboard chord as a native paste event', () => {
    // Remapped paste chords fire no native event and must stay consumed to avoid raw control characters.
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'y', ctrlKey: true }), false)).toBe(false)
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'd', ctrlKey: true }), false)).toBe(false)
    // Cmd+V does not fire a native paste event on Windows/Linux.
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'v', metaKey: true }), false)).toBe(false)
    // Ctrl+V does not fire a native paste event on macOS (readline quote-insert).
    expect(firesNativePasteEvent(makeKeyEvent({ key: 'v', ctrlKey: true }), true)).toBe(false)
  })
})
