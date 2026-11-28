import { describe, expect, it, vi } from 'vitest'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'

describe('pasteTerminalClipboard', () => {
  it('asks for an image when only the paste event listed files and the read skipped the check', async () => {
    const pasteFiles = vi.fn(async () => {})
    const pasteText = vi.fn(() => true)
    const result = await pasteTerminalClipboard({
      readClipboardContent: async () => ({ text: '', filePaths: [], linkHtml: '', hasImage: null }),
      eventCopiedFilePaths: ['C:\\shots\\shot.png'],
      copiedFiles: { hasImage: async () => true, paste: pasteFiles },
      saveClipboardImageAsTempFile: async () => '/tmp/orca-paste.png',
      pasteText
    })
    expect(result).toEqual({ status: 'pasted', kind: 'image-path' })
    expect(pasteFiles).not.toHaveBeenCalled()
    expect(pasteText).toHaveBeenCalledWith('/tmp/orca-paste.png', expect.anything())
  })
})
