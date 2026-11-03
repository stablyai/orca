// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'

const platform = vi.hoisted(() => {
  const state: { value: NodeJS.Platform; keybindings: KeybindingOverrides } = {
    value: 'linux',
    keybindings: {}
  }
  return state
})
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platform.value }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ keybindings: platform.keybindings }) }
}))

beforeEach(() => {
  platform.keybindings = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only measures text through this canvas stub.
  const context = { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('preview native paste with real xterm', () => {
  it.each(
    (['darwin', 'linux', 'win32'] as const).flatMap((clientPlatform) =>
      [false, true].map((releaseModifierFirst) => ({ clientPlatform, releaseModifierFirst }))
    )
  )(
    'preserves native paste on $clientPlatform with modifier-first release=$releaseModifierFirst',
    async ({ clientPlatform, releaseModifierFirst }) => {
      platform.value = clientPlatform
      const container = document.createElement('div')
      document.body.append(container)
      const terminal = new Terminal({ vtExtensions: { kittyKeyboard: true } })
      terminal.open(container)
      const emitted: string[] = []
      terminal.onData((data) => emitted.push(data))
      const pasteClipboardText = vi.fn()
      const dispose = installPreviewTerminalKeyHandler({
        terminal,
        claimImeKeyEvent: () => false,
        pasteClipboardText,
        sendInput: (data) => terminal.input(data),
        getShortcutContext: () => ({
          clientPlatform,
          macOptionAsAlt: 'false',
          keybindings: platform.keybindings,
          terminalInput: null,
          getKittyKeyboardFlags: () => 10,
          terminalShortcutPolicy: undefined
        })
      })
      try {
        await new Promise<void>((resolve) => terminal.write('\x1b[>10u', resolve))
        const textarea = terminal.textarea!
        textarea.focus()
        for (const type of ['keydown', 'keyup']) {
          const event = new KeyboardEvent(type, {
            key: 'v',
            code: 'KeyV',
            keyCode: 86,
            metaKey: clientPlatform === 'darwin' && (type === 'keydown' || !releaseModifierFirst),
            ctrlKey: clientPlatform !== 'darwin' && (type === 'keydown' || !releaseModifierFirst),
            bubbles: true,
            cancelable: true
          })
          textarea.dispatchEvent(event)
          if (type === 'keydown') {
            expect(event.defaultPrevented).toBe(false)
          }
        }
        expect(emitted).toEqual([])
        const clipboard = new DataTransfer()
        clipboard.setData('text/plain', 'native text')
        textarea.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true
          })
        )
        expect(emitted).toEqual(['native text'])
        expect(pasteClipboardText).not.toHaveBeenCalled()
      } finally {
        dispose()
        terminal.dispose()
      }
    }
  )

  it.each(['linux', 'win32'] as const)(
    'honors reassigned native paste chords on %s',
    async (clientPlatform) => {
      platform.value = clientPlatform
      platform.keybindings = {
        'terminal.paste': ['Ctrl+Shift+P'],
        'terminal.selectAll': ['Ctrl+V']
      }
      const container = document.createElement('div')
      document.body.append(container)
      const terminal = new Terminal({ vtExtensions: { kittyKeyboard: true } })
      terminal.open(container)
      const emitted: string[] = []
      terminal.onData((data) => emitted.push(data))
      const pasteClipboardText = vi.fn()
      const dispose = installPreviewTerminalKeyHandler({
        terminal,
        claimImeKeyEvent: () => false,
        pasteClipboardText,
        sendInput: (data) => terminal.input(data),
        getShortcutContext: () => ({
          clientPlatform,
          macOptionAsAlt: 'false',
          keybindings: platform.keybindings,
          terminalInput: null,
          getKittyKeyboardFlags: () => 10,
          terminalShortcutPolicy: undefined
        })
      })
      try {
        await new Promise<void>((resolve) => terminal.write('select this\x1b[>10u', resolve))
        const textarea = terminal.textarea!
        textarea.focus()
        const keydown = new KeyboardEvent('keydown', {
          key: 'v',
          code: 'KeyV',
          keyCode: 86,
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
        textarea.dispatchEvent(keydown)
        expect(keydown.defaultPrevented).toBe(true)
        expect(terminal.getSelection()).toContain('select this')
        textarea.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'v',
            code: 'KeyV',
            keyCode: 86,
            bubbles: true,
            cancelable: true
          })
        )
        expect(emitted).toEqual([])
        expect(pasteClipboardText).not.toHaveBeenCalled()
      } finally {
        dispose()
        terminal.dispose()
      }
    }
  )
})
