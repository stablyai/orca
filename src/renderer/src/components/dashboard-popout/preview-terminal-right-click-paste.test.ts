// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'

describe('installPreviewTerminalRightClickPaste', () => {
  const writeTerminalClipboardText = vi.fn(async () => {})
  const pasteClipboardText = vi.fn()
  let container: HTMLElement
  let selection: string
  let clearSelection: ReturnType<typeof vi.fn<() => void>>
  let focus: ReturnType<typeof vi.fn<() => void>>
  let rightClickToPaste: boolean

  const install = (): (() => void) =>
    installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => ({ getSelection: () => selection, clearSelection, focus }),
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
    focus = vi.fn<() => void>()
    rightClickToPaste = true
    Object.assign(window, { api: { ui: { writeTerminalClipboardText } } })
  })

  it('pastes when nothing is selected', () => {
    install()
    const event = rightClick()
    expect(event.defaultPrevented).toBe(true)
    expect(pasteClipboardText).toHaveBeenCalledWith(document.activeElement, 'right-click')
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
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

  // Why: xterm reports a right press to a mouse-tracking TUI, and Codex pastes on
  // that report itself, so the press must never reach xterm's element (#25192).
  const pressTerminalElement = (
    init: MouseEventInit
  ): { reachedXterm: boolean; event: MouseEvent } => {
    const xtermElement = document.createElement('div')
    container.appendChild(xtermElement)
    let reachedXterm = false
    xtermElement.addEventListener('mousedown', () => {
      reachedXterm = true
    })
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init })
    xtermElement.dispatchEvent(event)
    return { reachedXterm, event }
  }

  it('claims a right press before xterm sees it and keeps the terminal focused', () => {
    install()
    const { reachedXterm, event } = pressTerminalElement({ button: 2 })
    expect(reachedXterm).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
  })

  it.each([
    ['Ctrl+right press', { button: 2, ctrlKey: true }, true],
    ['left press', { button: 0 }, true],
    ['right press with the setting off', { button: 2 }, false]
  ])('lets a %s reach xterm', (_name, init, enabled) => {
    rightClickToPaste = enabled
    install()
    const { reachedXterm, event } = pressTerminalElement(init)
    expect(reachedXterm).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(focus).not.toHaveBeenCalled()
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
