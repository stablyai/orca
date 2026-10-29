import { describe, expect, it } from 'vitest'

import { CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR } from '../../../../shared/clipboard-text'
import { formatTerminalTextPasteError } from './terminal-paste-errors'

describe('terminal text paste error formatting', () => {
  it('names the unresponsive clipboard when the bounded read reports no delivery', () => {
    expect(formatTerminalTextPasteError(new Error(CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR))).toBe(
      'Paste skipped: the clipboard is not responding. Try again in a moment.'
    )
  })

  it('keeps the too-large guidance for every other text paste error', () => {
    expect(formatTerminalTextPasteError(new Error('something else'))).toBe(
      'Paste failed: clipboard text is too large for a safe terminal paste.'
    )
  })
})
