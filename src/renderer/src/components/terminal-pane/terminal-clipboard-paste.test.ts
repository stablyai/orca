import { describe, expect, it, vi } from 'vitest'

import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import {
  markTerminalBracketedPasteInterrupted,
  pasteTerminalText
} from './terminal-bracketed-paste'

describe('terminal clipboard paste', () => {
  it('forces bracketed paste for generated image-only clipboard paths', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue(
          '/var/folders/3l/b7w02vh17tg5r5s3nhhdf3kh0000gn/T/orca-paste-1760000000000-id.png'
        ),
      pasteText
    })

    expect(pasteText).toHaveBeenCalledWith(
      '/var/folders/3l/b7w02vh17tg5r5s3nhhdf3kh0000gn/T/orca-paste-1760000000000-id.png',
      { forceBracketedPaste: true }
    )
  })

  it('forces generated image paste onto the native bracketed-paste path after Ctrl+C', async () => {
    const observedIgnoreBracketedPasteMode: boolean[] = []
    const terminal = {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
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
      pasteText: (text, options) => pasteTerminalText(terminal, text, options)
    })

    expect(terminal.paste).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(observedIgnoreBracketedPasteMode).toEqual([true])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('forces generated image paste even when xterm bracketed paste mode is off', async () => {
    const observedIgnoreBracketedPasteMode: boolean[] = []
    const terminal = {
      modes: { bracketedPasteMode: false },
      options: { ignoreBracketedPasteMode: false },
      paste: vi.fn(() => {
        observedIgnoreBracketedPasteMode.push(terminal.options.ignoreBracketedPasteMode)
      })
    }

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: (text, options) => pasteTerminalText(terminal, text, options)
    })

    expect(terminal.paste).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(observedIgnoreBracketedPasteMode).toEqual([true])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('forwards SSH connection context and bracket-pastes the returned remote image path', async () => {
    const pasteText = vi.fn()
    const saveClipboardImageAsTempFile = vi
      .fn()
      .mockResolvedValue('/var/tmp/orca-paste-1760000000000-id.png')

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile,
      connectionId: 'ssh-1',
      pasteText
    })

    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(pasteText).toHaveBeenCalledWith('/var/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true
    })
  })

  it('bracket-pastes generated image paths without relying on agent detection', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText
    })

    expect(pasteText).toHaveBeenCalledWith('/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true
    })
  })

  it('still tries image paste when browser text clipboard reads fail', async () => {
    const pasteText = vi.fn()
    const saveClipboardImageAsTempFile = vi
      .fn()
      .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png')

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockRejectedValue(new Error('No text clipboard permission')),
      saveClipboardImageAsTempFile,
      pasteText
    })

    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({ connectionId: undefined })
    expect(pasteText).toHaveBeenCalledWith('/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true
    })
  })

  it('preserves the text fast path without probing for images', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      saveClipboardImageAsTempFile,
      pasteText
    })

    expect(pasteText).toHaveBeenCalledWith('hello')
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('keeps normal single-line text paste on the stale Ctrl+C protection path', async () => {
    const observedIgnoreBracketedPasteMode: boolean[] = []
    const terminal = {
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      paste: vi.fn(() => {
        observedIgnoreBracketedPasteMode.push(terminal.options.ignoreBracketedPasteMode)
      })
    }
    const saveClipboardImageAsTempFile = vi.fn()
    markTerminalBracketedPasteInterrupted(terminal)

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('a69ce28e1d092e0c8825cd1a109ac36409962bc1'),
      saveClipboardImageAsTempFile,
      pasteText: (text, options) => pasteTerminalText(terminal, text, options)
    })

    expect(terminal.paste).toHaveBeenCalledWith('a69ce28e1d092e0c8825cd1a109ac36409962bc1')
    expect(observedIgnoreBracketedPasteMode).toEqual([true])
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })
})
