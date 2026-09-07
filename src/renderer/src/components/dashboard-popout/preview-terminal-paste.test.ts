// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { createPreviewClipboardPaster } from './preview-terminal-paste'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

const IMAGE_PATH = '/var/folders/h4/T/orca-paste-1788731844571-id.png'

describe('createPreviewClipboardPaster', () => {
  const readClipboardText = vi.fn<(options?: unknown) => Promise<string>>()
  const saveClipboardImageAsTempFile = vi.fn<(args?: unknown) => Promise<string | null>>()
  const previewInput = vi.fn(async () => {})
  let container: HTMLElement
  let focusTarget: HTMLElement
  let terminal: {
    modes: { bracketedPasteMode: boolean }
    input: ReturnType<typeof vi.fn>
    paste: ReturnType<typeof vi.fn>
  }
  let terminalInput: DashboardCardTerminalInput | null
  let disposed: boolean

  const paste = (source: 'keyboard' | 'app-menu' | 'right-click' = 'keyboard'): Promise<void> =>
    createPreviewClipboardPaster({
      ptyId: 'pty-1',
      container,
      getTerminal: () => terminal as unknown as Terminal,
      getTerminalInput: () => terminalInput,
      isDisposed: () => disposed
    })(document.activeElement, source)

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    container = document.createElement('div')
    focusTarget = document.createElement('textarea')
    container.appendChild(focusTarget)
    document.body.appendChild(container)
    focusTarget.focus()
    terminal = { modes: { bracketedPasteMode: true }, input: vi.fn(), paste: vi.fn() }
    terminalInput = null
    disposed = false
    readClipboardText.mockResolvedValue('')
    saveClipboardImageAsTempFile.mockResolvedValue(null)
    Object.assign(window, {
      api: {
        ui: { readClipboardText, saveClipboardImageAsTempFile },
        terminalPreview: { input: previewInput }
      }
    })
  })

  it('pastes an image-only clipboard as a bracketed temp-file path', async () => {
    saveClipboardImageAsTempFile.mockResolvedValue(IMAGE_PATH)
    await paste()
    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: null,
      runtimeEnvironmentId: null
    })
    expect(terminal.input).toHaveBeenCalledWith(`\x1b[200~${IMAGE_PATH}\x1b[201~`)
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('writes the image on the pty host named by the terminal input', async () => {
    terminalInput = {
      hostPlatform: 'linux',
      localWindowsConpty: false,
      windowsShiftEnterEncoding: 'alt-enter',
      ctrlEnterCsiU: false,
      kittyKeyboardAdvertised: true,
      connectionId: 'conn-1',
      runtimeEnvironmentId: null
    }
    saveClipboardImageAsTempFile.mockResolvedValue(IMAGE_PATH)
    await paste()
    expect(saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      runtimeEnvironmentId: null
    })
    expect(terminal.input).toHaveBeenCalledWith(`\x1b[200~${IMAGE_PATH}\x1b[201~`)
  })

  it('prefers clipboard text over an image', async () => {
    readClipboardText.mockResolvedValue('hello')
    saveClipboardImageAsTempFile.mockResolvedValue(IMAGE_PATH)
    await paste()
    expect(terminal.paste).toHaveBeenCalledWith('hello')
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('still tries the image when the text read rejects, as image-only clipboards can', async () => {
    readClipboardText.mockRejectedValue(new Error('no text'))
    saveClipboardImageAsTempFile.mockResolvedValue(IMAGE_PATH)
    await paste()
    expect(terminal.input).toHaveBeenCalledWith(`\x1b[200~${IMAGE_PATH}\x1b[201~`)
  })

  it('does nothing for an empty clipboard', async () => {
    await paste()
    expect(terminal.input).not.toHaveBeenCalled()
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('never writes a temp file for a card that no longer owns focus', async () => {
    saveClipboardImageAsTempFile.mockResolvedValue(IMAGE_PATH)
    const activeElementAtDispatch = document.activeElement
    focusTarget.blur()
    await createPreviewClipboardPaster({
      ptyId: 'pty-1',
      container,
      getTerminal: () => terminal as unknown as Terminal,
      getTerminalInput: () => terminalInput,
      isDisposed: () => disposed
    })(activeElementAtDispatch, 'keyboard')
    expect(readClipboardText).not.toHaveBeenCalled()
    expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(terminal.input).not.toHaveBeenCalled()
  })

  it('drops the paste when the terminal is disposed during the clipboard read', async () => {
    readClipboardText.mockImplementation(async () => {
      disposed = true
      return 'hello'
    })
    await paste()
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(terminal.input).not.toHaveBeenCalled()
  })
})
