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
      { forceBracketedPaste: true, recoverImagePasteWebglAtlas: true }
    )
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
      pasteText: (text, options) => pasteTerminalText(terminal, text, options)
    })

    expect(terminal.input).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(observedIgnoreBracketedPasteMode).toEqual([false])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('forces generated image paste even when xterm bracketed paste mode is off', async () => {
    const observedIgnoreBracketedPasteMode: boolean[] = []
    const terminal = {
      modes: { bracketedPasteMode: false },
      options: { ignoreBracketedPasteMode: false },
      input: vi.fn(() => {
        observedIgnoreBracketedPasteMode.push(terminal.options.ignoreBracketedPasteMode)
      }),
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

    expect(terminal.input).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(observedIgnoreBracketedPasteMode).toEqual([false])
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
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
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
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
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
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
  })

  it('preserves the text fast path without probing for images', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()
    const readClipboardText = vi.fn().mockResolvedValue('hello')

    await pasteTerminalClipboard({
      readClipboardText,
      saveClipboardImageAsTempFile,
      pasteText
    })

    expect(pasteText).toHaveBeenCalledWith('hello')
    expect(readClipboardText).toHaveBeenCalledWith({ maxBytes: 16 * 1024 * 1024 })
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('reports text paste execution failures without probing for image fallback', async () => {
    const pasteError = new Error('terminal disconnected')
    const saveClipboardImageAsTempFile = vi.fn()
    const onTextPasteError = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      saveClipboardImageAsTempFile,
      pasteText: vi.fn(() => {
        throw pasteError
      }),
      onTextPasteError
    })

    expect(onTextPasteError).toHaveBeenCalledWith(pasteError)
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'skipped', reason: 'text-paste-failed' })
  })

  it('reports rejected text paste execution without probing for image fallback', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const onTextPasteError = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      saveClipboardImageAsTempFile,
      pasteText: vi.fn().mockResolvedValue(false),
      onTextPasteError
    })

    expect(onTextPasteError).not.toHaveBeenCalled()
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'skipped', reason: 'text-paste-rejected' })
  })

  it('rejects oversized clipboard text without probing for image fallback', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()
    const onTextPasteError = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi
        .fn()
        .mockRejectedValue(new Error('Clipboard text is too large for this paste target.')),
      saveClipboardImageAsTempFile,
      pasteText,
      onTextPasteError
    })

    expect(onTextPasteError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Clipboard text is too large for this paste target.'
      })
    )
    expect(pasteText).not.toHaveBeenCalled()
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'skipped', reason: 'text-too-large' })
  })

  it('reports rejected image-path paste without treating it as image extraction failure', async () => {
    const onImagePasteError = vi.fn()
    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: vi.fn().mockResolvedValue(false),
      onImagePasteError
    })

    expect(onImagePasteError).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'skipped', reason: 'image-paste-rejected' })
  })

  it('reports image extraction failures without attempting image-path paste', async () => {
    const imageError = new Error('no image data')
    const pasteText = vi.fn()
    const onImagePasteError = vi.fn()
    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      saveClipboardImageAsTempFile: vi.fn().mockRejectedValue(imageError),
      pasteText,
      onImagePasteError
    })

    expect(pasteText).not.toHaveBeenCalled()
    expect(onImagePasteError).toHaveBeenCalledWith(imageError)
    expect(result).toEqual({ status: 'skipped', reason: 'image-paste-failed' })
  })

  it('forces Windows multi-line text paste onto the bracketed-paste path', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('line one\nline two'),
      saveClipboardImageAsTempFile,
      pasteText,
      forceBracketedMultilineTextPaste: true
    })

    expect(pasteText).toHaveBeenCalledWith('line one\nline two', {
      forceBracketedPasteForMultiline: true
    })
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('delegates multiline protection to the terminal paste coordinator', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('line one\nline two'),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText,
      forceBracketedMultilineTextPaste: true
    })

    expect(pasteText).toHaveBeenCalledWith('line one\nline two', {
      forceBracketedPasteForMultiline: true
    })
  })

  it('keeps single-line text on the ordinary paste path when Windows multi-line protection is on', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      saveClipboardImageAsTempFile,
      pasteText,
      forceBracketedMultilineTextPaste: true
    })

    expect(pasteText).toHaveBeenCalledWith('hello', {
      forceBracketedPasteForMultiline: true
    })
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('does not pre-scan large text before delegating multiline policy', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()
    const codePointAtSpy = vi.spyOn(String.prototype, 'codePointAt')

    try {
      await pasteTerminalClipboard({
        readClipboardText: vi.fn().mockResolvedValue('x'.repeat(64)),
        saveClipboardImageAsTempFile,
        pasteText,
        forceBracketedMultilineTextPaste: true
      })

      expect(codePointAtSpy).not.toHaveBeenCalled()
    } finally {
      codePointAtSpy.mockRestore()
    }
    expect(pasteText).toHaveBeenCalledWith('x'.repeat(64), {
      forceBracketedPasteForMultiline: true
    })
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('keeps normal single-line text paste on the stale Ctrl+C protection path', async () => {
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
