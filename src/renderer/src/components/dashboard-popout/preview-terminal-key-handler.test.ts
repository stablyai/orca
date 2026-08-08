// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'

const shortcutPlatform = vi.hoisted(() => ({ value: 'linux' as 'darwin' | 'linux' }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => shortcutPlatform.value }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ keybindings: undefined }) }
}))

describe('preview terminal IME action ownership', () => {
  let handler: ((event: KeyboardEvent) => boolean) | null
  let writeTerminalClipboardText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handler = null
    shortcutPlatform.value = 'linux'
    writeTerminalClipboardText = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeTerminalClipboardText } }
    })
  })

  function install(kittyKeyboardActive = false): void {
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
        kittyKeyboardActive: () => kittyKeyboardActive,
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

  it('lets macOS own the recorded unmarked initial jamo', () => {
    shortcutPlatform.value = 'darwin'
    install()
    const event = new KeyboardEvent('keydown', { key: 'ㄱ' })
    Object.defineProperties(event, {
      code: { value: 'KeyR' },
      keyCode: { value: 82 }
    })

    expect(handler?.(event)).toBe(false)
  })

  it('leaves ordinary unmodified Latin input with xterm', () => {
    shortcutPlatform.value = 'darwin'
    install()
    const event = new KeyboardEvent('keydown', { code: 'KeyR', key: 'r' })
    Object.defineProperty(event, 'keyCode', { value: 82 })

    expect(handler?.(event)).toBe(true)
  })

  it('leaves physical Backslash to native macOS keypress', () => {
    shortcutPlatform.value = 'darwin'
    install()

    expect(handler?.(new KeyboardEvent('keydown', { code: 'Backslash', key: '\\' }))).toBe(false)
  })

  it('keeps physical Backslash in xterm while kitty reporting is active', () => {
    shortcutPlatform.value = 'darwin'
    install(true)

    expect(handler?.(new KeyboardEvent('keydown', { code: 'Backslash', key: '\\' }))).toBe(true)
  })
})
