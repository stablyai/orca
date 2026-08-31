import { describe, expect, it } from 'vitest'

import {
  formatDeferredTerminalPasteDroppedError,
  formatTerminalPasteExecutionError,
  TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE
} from './terminal-paste-errors'

describe('terminal paste error copy', () => {
  it('tells the user how to recover a deferred paste that timed out, per platform', () => {
    // The payload is already gone, so the copy has to be actionable, and the chord
    // label has to match the platform the user is actually on (reported on Win 11).
    expect(formatDeferredTerminalPasteDroppedError('deadline-passed', 'darwin')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press ⌘V to paste again.'
    )
    expect(formatDeferredTerminalPasteDroppedError('deadline-passed', 'win32')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press Ctrl+V to paste again.'
    )
    expect(formatDeferredTerminalPasteDroppedError('deadline-passed', 'linux')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press Ctrl+V to paste again.'
    )
  })

  // Three causes reach this toast. Telling a user whose pane was closed, or who
  // clicked a sibling terminal, that "focus did not return in time" is simply false.
  it('names the cause it actually hit rather than flattening all three into the timeout', () => {
    expect(formatDeferredTerminalPasteDroppedError('target-pane-closed', 'darwin')).toBe(
      'Paste cancelled: the terminal it was meant for was closed. Click the terminal and press ⌘V to paste again.'
    )
    expect(formatDeferredTerminalPasteDroppedError('focus-moved-to-other-pane', 'win32')).toBe(
      'Paste cancelled: focus moved to a different terminal. Click the terminal and press Ctrl+V to paste again.'
    )
    const causes = ['deadline-passed', 'target-pane-closed', 'focus-moved-to-other-pane'] as const
    const messages = causes.map((cause) => formatDeferredTerminalPasteDroppedError(cause, 'darwin'))
    expect(new Set(messages).size).toBe(causes.length)
  })

  it('names a failed clipboard read as a failure, never as an empty clipboard', () => {
    expect(TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE).toBe(
      'Paste failed: could not read the clipboard. Copy again, then retry.'
    )
    // Distinct from every execution-stage message, so the toast cannot be mistaken
    // for a focus or transport problem.
    const executionMessages = (
      [
        'payload-too-large',
        'stale-target',
        'target-disconnected',
        'pty-writer-unavailable',
        'operation-timeout',
        undefined
      ] as const
    ).map((reason) => formatTerminalPasteExecutionError(reason))
    expect(executionMessages).not.toContain(TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE)
  })
})
