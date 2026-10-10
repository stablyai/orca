// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'

describe('installPreviewTerminalRightClickPaste', () => {
  const writeTerminalClipboardText = vi.fn(async () => {})
  const pasteClipboardText = vi.fn()
  let container: HTMLElement
  let selection: string
  let clearSelection: ReturnType<typeof vi.fn<() => void>>
  let rightClickToPaste: boolean
  let mouseTrackingMode: 'none' | 'any'

  const install = (): (() => void) =>
    installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => ({
        getSelection: () => selection,
        clearSelection,
        modes: { mouseTrackingMode }
      }),
      isRightClickToPasteEnabled: () => rightClickToPaste,
      pasteClipboardText
    })

  const rightClick = (init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init })
    container.dispatchEvent(event)
    return event
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    selection = ''
    clearSelection = vi.fn<() => void>()
    rightClickToPaste = true
    mouseTrackingMode = 'none'
    // Why: pin a non-Mac platform so Shift is the selection-forcing modifier.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
    Object.assign(window, { api: { ui: { writeTerminalClipboardText } } })
  })

  it('pastes when nothing is selected', () => {
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(pasteClipboardText).toHaveBeenCalledWith(document.activeElement, 'right-click')
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Issue #25192: Codex and pi paste on the forwarded right-button report themselves.
  it('leaves the paste to a mouse-tracking TUI', () => {
    mouseTrackingMode = 'any'
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('still pastes on Shift+right-click, which xterm never reports to a tracking TUI', () => {
    mouseTrackingMode = 'any'
    install()
    rightClick({ shiftKey: true })
    expect(pasteClipboardText).toHaveBeenCalledWith(document.activeElement, 'right-click')
  })

  it('copies and clears the selection instead of pasting', async () => {
    selection = 'selected text'
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text')
    await vi.waitFor(() => expect(clearSelection).toHaveBeenCalledOnce())
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('keeps the selection when the clipboard write fails', async () => {
    selection = 'selected text'
    writeTerminalClipboardText.mockRejectedValueOnce(new Error('denied'))
    install()
    rightClick()
    await Promise.resolve()
    expect(clearSelection).not.toHaveBeenCalled()
  })

  it('falls through to the native menu on Ctrl+right-click', () => {
    install()
    const event = rightClick({ ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('falls through to the native menu when the setting is off', () => {
    rightClickToPaste = false
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })

  it('falls through before the terminal exists and stops listening once disposed', () => {
    const dispose = installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => null,
      isRightClickToPasteEnabled: () => true,
      pasteClipboardText
    })
    expect(rightClick().defaultPrevented).toBe(false)
    dispose()

    const disposeSecond = install()
    disposeSecond()
    expect(rightClick().defaultPrevented).toBe(false)
    expect(pasteClipboardText).not.toHaveBeenCalled()
  })
})
