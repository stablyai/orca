// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ keybindings: undefined }) }
}))

describe('preview terminal IME action ownership', () => {
  let handler: ((event: KeyboardEvent) => boolean) | null
  let writeTerminalClipboardText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handler = null
    writeTerminalClipboardText = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeTerminalClipboardText } }
    })
  })

  function install(): void {
    const terminal = {
      attachCustomKeyEventHandler: (next: (event: KeyboardEvent) => boolean) => {
        handler = next
      },
      getSelection: () => 'selected'
    } as unknown as Terminal
    installPreviewTerminalKeyHandler({
      terminal,
      pasteClipboardText: vi.fn(),
      sendInput: vi.fn(),
      getShortcutContext: () => ({
        clientPlatform: 'linux',
        macOptionAsAlt: 'false',
        keybindings: undefined,
        terminalInput: null,
        kittyKeyboardActive: () => false,
        terminalShortcutPolicy: 'orca-first'
      })
    })
  }

  function copyEvent(isComposing: boolean): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      ctrlKey: true,
      isComposing,
      key: 'C',
      shiftKey: true
    })
    Object.defineProperty(event, 'keyCode', { value: 13 })
    return event
  }

  it('refuses the marked real key shape before the copy action', () => {
    install()

    expect(handler?.(copyEvent(true))).toBe(true)
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  it('leaves the ordinary copy shortcut unchanged', () => {
    install()

    expect(handler?.(copyEvent(false))).toBe(false)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected')
  })
})
