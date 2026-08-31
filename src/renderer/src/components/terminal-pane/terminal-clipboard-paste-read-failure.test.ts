import { describe, expect, it, vi } from 'vitest'

import { CLIPBOARD_TEXT_TOO_LARGE_ERROR } from '../../../../shared/clipboard-text'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'

// STA-5272 defect 2: a clipboard text read that FAILS is `unavailable`, never `empty`.
// Collapsing the two makes a failed read look to the user like "you copied nothing":
// no paste, no error, no toast.
describe('terminal clipboard paste: failed read is not an empty clipboard', () => {
  it('reports a failed text read as clipboard-read-failed, not empty', async () => {
    const readError = new Error('Read permission denied')
    const onClipboardReadUnavailable = vi.fn()
    const onTextPasteError = vi.fn()
    const pasteText = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockRejectedValue(readError),
      saveClipboardImageAsTempFile: vi.fn().mockResolvedValue(null),
      pasteText,
      onClipboardReadUnavailable,
      onTextPasteError
    })

    expect(result).toEqual({ status: 'skipped', reason: 'clipboard-read-failed' })
    expect(onClipboardReadUnavailable).toHaveBeenCalledTimes(1)
    expect(onClipboardReadUnavailable).toHaveBeenCalledWith(readError)
    // The too-large path owns onTextPasteError; a plain read failure must not borrow it.
    expect(onTextPasteError).not.toHaveBeenCalled()
    expect(pasteText).not.toHaveBeenCalled()
  })

  it('keeps a genuinely empty clipboard silent', async () => {
    const onClipboardReadUnavailable = vi.fn()
    const onTextPasteError = vi.fn()
    const onImagePasteError = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi.fn().mockResolvedValue(null),
      pasteText: vi.fn(),
      onClipboardReadUnavailable,
      onTextPasteError,
      onImagePasteError
    })

    expect(result).toEqual({ status: 'skipped', reason: 'empty' })
    expect(onClipboardReadUnavailable).not.toHaveBeenCalled()
    expect(onTextPasteError).not.toHaveBeenCalled()
    expect(onImagePasteError).not.toHaveBeenCalled()
  })

  it('still pastes an image when the text read failed on an image-only clipboard', async () => {
    const onClipboardReadUnavailable = vi.fn()
    const pasteText = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockRejectedValue(new Error('No text on clipboard')),
      saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/orca-paste-1.png'),
      pasteText,
      onClipboardReadUnavailable
    })

    expect(result).toEqual({ status: 'pasted', kind: 'image-path' })
    expect(pasteText).toHaveBeenCalledWith('/tmp/orca-paste-1.png', {
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
    expect(onClipboardReadUnavailable).not.toHaveBeenCalled()
  })

  it('leaves the too-large read on its own error path', async () => {
    const tooLarge = new Error(CLIPBOARD_TEXT_TOO_LARGE_ERROR)
    const onClipboardReadUnavailable = vi.fn()
    const onTextPasteError = vi.fn()
    const saveClipboardImageAsTempFile = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockRejectedValue(tooLarge),
      saveClipboardImageAsTempFile,
      pasteText: vi.fn(),
      onClipboardReadUnavailable,
      onTextPasteError
    })

    expect(result).toEqual({ status: 'skipped', reason: 'text-too-large' })
    expect(onTextPasteError).toHaveBeenCalledWith(tooLarge)
    expect(onClipboardReadUnavailable).not.toHaveBeenCalled()
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })
})
