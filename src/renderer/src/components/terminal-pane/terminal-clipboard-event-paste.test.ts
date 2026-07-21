import { describe, expect, it } from 'vitest'
import {
  getClipboardEventText,
  shouldUseClipboardEventPaste
} from './terminal-clipboard-event-paste'

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
