// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { installTerminalSelectionCopyHandler } from './terminal-selection-copy-event'

function makeTerminal(selection: string) {
  const element = document.createElement('div')
  return { element, getSelection: () => selection }
}

function dispatchCopy(element: HTMLElement, withClipboardData = true) {
  const event = new Event('copy', { bubbles: true, cancelable: true })
  const clipboardData = withClipboardData ? { setData: vi.fn() } : undefined
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  element.dispatchEvent(event)
  return { event, clipboardData }
}

describe('installTerminalSelectionCopyHandler', () => {
  it('writes a non-empty selection and prevents xterm from handling the copy', async () => {
    const terminal = makeTerminal('remote answer')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    const downstream = vi.fn()
    installTerminalSelectionCopyHandler(terminal, writeClipboardText)
    terminal.element.addEventListener('copy', downstream)

    const { event, clipboardData } = dispatchCopy(terminal.element)
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(true)
    expect(clipboardData?.setData).toHaveBeenCalledWith('text/plain', 'remote answer')
    expect(writeClipboardText).toHaveBeenCalledWith('remote answer')
    expect(downstream).not.toHaveBeenCalled()
  })

  it('leaves an empty selection to the native copy path', () => {
    const terminal = makeTerminal('')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    installTerminalSelectionCopyHandler(terminal, writeClipboardText)

    const { event } = dispatchCopy(terminal.element)

    expect(event.defaultPrevented).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('leaves events without clipboardData to the native copy path', () => {
    const terminal = makeTerminal('remote answer')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()

    installTerminalSelectionCopyHandler(terminal, writeClipboardText)
    const { event } = dispatchCopy(terminal.element, false)

    expect(event.defaultPrevented).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('swallows clipboard write failures and stops intercepting after disposal', async () => {
    const terminal = makeTerminal('remote answer')
    const writeClipboardText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('clipboard unavailable'))
    const disposable = installTerminalSelectionCopyHandler(terminal, writeClipboardText)

    const { clipboardData } = dispatchCopy(terminal.element)
    await Promise.resolve()
    expect(clipboardData?.setData).toHaveBeenCalledWith('text/plain', 'remote answer')
    expect(writeClipboardText).toHaveBeenCalledOnce()

    disposable.dispose()
    const { event: nextEvent } = dispatchCopy(terminal.element)
    expect(nextEvent.defaultPrevented).toBe(false)
    expect(writeClipboardText).toHaveBeenCalledOnce()
  })

  it('is inert before xterm has opened an element', () => {
    expect(() =>
      installTerminalSelectionCopyHandler(
        { getSelection: () => 'remote answer' },
        vi.fn()
      ).dispose()
    ).not.toThrow()
  })
})
