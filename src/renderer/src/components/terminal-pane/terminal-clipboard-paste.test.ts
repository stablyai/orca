import { describe, expect, it, vi } from 'vitest'

import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import {
  markTerminalBracketedPasteInterrupted,
  pasteTerminalText
} from './terminal-bracketed-paste'

// Defaults so tests only spell out the clipboard branch they exercise.
const noClipboardFilePaths = (): (() => Promise<string[]>) => vi.fn().mockResolvedValue([])
const noClipboardFilePaste = (): ((paths: string[]) => void) => vi.fn()

describe('terminal clipboard paste', () => {
  it('forces bracketed paste for generated image-only clipboard paths', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue(
          '/var/folders/3l/b7w02vh17tg5r5s3nhhdf3kh0000gn/T/orca-paste-1760000000000-id.png'
        ),
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: (text, options) => pasteTerminalText(terminal, text, options),
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: (text, options) => pasteTerminalText(terminal, text, options),
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      connectionId: 'ssh-1',
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
    })

    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      runtimeEnvironmentId: undefined
    })
    expect(pasteText).toHaveBeenCalledWith('/var/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
  })

  it('forwards remote runtime context and bracket-pastes the runtime image path', async () => {
    const pasteText = vi.fn()
    const saveClipboardImageAsTempFile = vi
      .fn()
      .mockResolvedValue('/tmp/orca-paste-1760000000000-runtime.png')

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      runtimeEnvironmentId: 'remote-host-1',
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
    })

    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: undefined,
      runtimeEnvironmentId: 'remote-host-1'
    })
    expect(pasteText).toHaveBeenCalledWith('/tmp/orca-paste-1760000000000-runtime.png', {
      forceBracketedPaste: true,
      recoverImagePasteWebglAtlas: true
    })
  })

  it('bracket-pastes generated image paths without relying on agent detection', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue(''),
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
    })

    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: undefined,
      runtimeEnvironmentId: undefined
    })
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText: vi.fn(() => {
        throw pasteError
      }),
      onTextPasteError,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText: vi.fn().mockResolvedValue(false),
      onTextPasteError,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText,
      onTextPasteError,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi
        .fn()
        .mockResolvedValue('/tmp/orca-paste-1760000000000-id.png'),
      pasteText: vi.fn().mockResolvedValue(false),
      onImagePasteError,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi.fn().mockRejectedValue(imageError),
      pasteText,
      onImagePasteError,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText,
      forceBracketedMultilineTextPaste: true,
      pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText,
      forceBracketedMultilineTextPaste: true,
      pasteFilePaths: noClipboardFilePaste()
    })

    expect(pasteText).toHaveBeenCalledWith('line one\nline two', {
      forceBracketedPasteForMultiline: true
    })
  })

  it('delegates Windows input-record newline protection without scanning text', async () => {
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('\nline two'),
      readClipboardFilePaths: noClipboardFilePaths(),
      pasteFilePaths: noClipboardFilePaste(),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText,
      protectedMultilineTextPasteOptions: { windowsInputRecordNewline: 'alt-enter' }
    })

    expect(pasteText).toHaveBeenCalledWith('\nline two', {
      windowsInputRecordNewline: 'alt-enter'
    })
  })

  it('keeps single-line text on the ordinary paste path when Windows multi-line protection is on', async () => {
    const saveClipboardImageAsTempFile = vi.fn()
    const pasteText = vi.fn()

    await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText,
      forceBracketedMultilineTextPaste: true,
      pasteFilePaths: noClipboardFilePaste()
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
        readClipboardFilePaths: noClipboardFilePaths(),
        saveClipboardImageAsTempFile,
        pasteText,
        forceBracketedMultilineTextPaste: true,
        pasteFilePaths: noClipboardFilePaste()
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
      readClipboardFilePaths: noClipboardFilePaths(),
      saveClipboardImageAsTempFile,
      pasteText: (text, options) => pasteTerminalText(terminal, text, options),
      pasteFilePaths: noClipboardFilePaste()
    })

    expect(terminal.paste).toHaveBeenCalledWith('a69ce28e1d092e0c8825cd1a109ac36409962bc1')
    expect(observedIgnoreBracketedPasteMode).toEqual([true])
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('routes OS-copied file paths before synthesized clipboard text', async () => {
    const pasteText = vi.fn()
    const pasteFilePaths = vi.fn()
    const saveClipboardImageAsTempFile = vi.fn()
    // macOS also puts the file's display name on the clipboard as text; the
    // file-path branch must win so the full path is pasted, not the bare name.
    const readClipboardText = vi.fn().mockResolvedValue('a file.txt')

    const result = await pasteTerminalClipboard({
      readClipboardText,
      readClipboardFilePaths: vi
        .fn()
        .mockResolvedValue(['/Users/me/a file.txt', '/Users/me/second.txt']),
      saveClipboardImageAsTempFile,
      pasteText,
      pasteFilePaths
    })

    expect(pasteFilePaths).toHaveBeenCalledWith(['/Users/me/a file.txt', '/Users/me/second.txt'])
    expect(pasteText).not.toHaveBeenCalled()
    expect(readClipboardText).not.toHaveBeenCalled()
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'pasted', kind: 'file-path' })
  })

  it('falls back to text/image paste when no OS file is on the clipboard', async () => {
    const pasteText = vi.fn()
    const readClipboardFilePaths = vi.fn().mockResolvedValue([])

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      readClipboardFilePaths,
      pasteFilePaths: noClipboardFilePaste(),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText
    })

    expect(readClipboardFilePaths).toHaveBeenCalledTimes(1)
    expect(pasteText).toHaveBeenCalledWith('hello')
    expect(result).toEqual({ status: 'pasted', kind: 'text' })
  })

  it('ignores copied-file read failures and keeps normal text paste', async () => {
    const pasteText = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn().mockResolvedValue('hello'),
      readClipboardFilePaths: vi.fn().mockRejectedValue(new Error('clipboard read failed')),
      pasteFilePaths: noClipboardFilePaste(),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText
    })

    expect(pasteText).toHaveBeenCalledWith('hello')
    expect(result).toEqual({ status: 'pasted', kind: 'text' })
  })

  it('reports rejected copied-file pastes without falling through to text', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('a file.txt')

    const result = await pasteTerminalClipboard({
      readClipboardText,
      readClipboardFilePaths: vi.fn().mockResolvedValue(['/Users/me/a file.txt']),
      pasteFilePaths: vi.fn().mockResolvedValue(false),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText: vi.fn()
    })

    expect(readClipboardText).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'skipped', reason: 'file-paste-rejected' })
  })

  it('reports copied-file paste failures separately from text failures', async () => {
    const pasteError = new Error('upload failed')
    const onFilePasteError = vi.fn()

    const result = await pasteTerminalClipboard({
      readClipboardText: vi.fn(),
      readClipboardFilePaths: vi.fn().mockResolvedValue(['/Users/me/a.txt']),
      pasteFilePaths: vi.fn().mockRejectedValue(pasteError),
      saveClipboardImageAsTempFile: vi.fn(),
      pasteText: vi.fn(),
      onFilePasteError
    })

    expect(onFilePasteError).toHaveBeenCalledWith(pasteError)
    expect(result).toEqual({ status: 'skipped', reason: 'file-paste-failed' })
  })
})
