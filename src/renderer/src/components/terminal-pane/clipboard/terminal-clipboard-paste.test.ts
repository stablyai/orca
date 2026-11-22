import { describe, expect, it, vi } from 'vitest'

import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import {
  markTerminalBracketedPasteInterrupted,
  pasteTerminalText
} from '../input/paste/terminal-bracketed-paste'

describe('terminal clipboard paste', () => {
  it('records a preview only after an image path reaches a local terminal', async () => {
    const onLocalImagePasted = vi.fn()
    const pasteText = vi.fn(() => true)
    const deps = {
      readClipboardText: async () => '',
      saveClipboardImageAsTempFile: async () => '/tmp/preview.png',
      prepareImagePath: async () => '/tmp/viewing-copy.png',
      onLocalImagePasted
    }
    await pasteTerminalClipboard({ ...deps, pasteText: () => true, connectionId: 'ssh-target' })
    await pasteTerminalClipboard({ ...deps, pasteText: () => true, runtimeEnvironmentId: 'paired' })
    expect(onLocalImagePasted).not.toHaveBeenCalled()

    await pasteTerminalClipboard({ ...deps, pasteText })
    expect(pasteText).toHaveBeenCalledWith('/tmp/viewing-copy.png', {
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
    expect(onLocalImagePasted).toHaveBeenCalledWith('/tmp/preview.png')
  })

  it('forces generated image paste onto the native bracketed-paste path after Ctrl+C', async () => {
    const observedIgnoreBracketedPasteMode: boolean[] = []
    const terminal = {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      input: vi.fn(() => {
        observedIgnoreBracketedPasteMode.push(terminal.options.ignoreBracketedPasteMode)
      }),
      paste: vi.fn(() => {
        observedIgnoreBracketedPasteMode.push(terminal.options.ignoreBracketedPasteMode)
      })
    }
    markTerminalBracketedPasteInterrupted(terminal)

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: (text, options) => {
        pasteTerminalText(terminal, text, options)
        return true
      }
    })

    expect(terminal.input).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(observedIgnoreBracketedPasteMode).toEqual([false])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })
})
