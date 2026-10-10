// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const storeState = vi.hoisted(() => ({ keybindings: {} }))

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'

function installHandler(): (event: KeyboardEvent) => boolean {
  let handler: ((event: KeyboardEvent) => boolean) | null = null
  const terminal = {
    attachCustomKeyEventHandler: (fn: (event: KeyboardEvent) => boolean) => {
      handler = fn
    }
  }
  installPreviewTerminalKeyHandler({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only touches attachCustomKeyEventHandler for these chords.
    terminal: terminal as unknown as Terminal,
    claimImeKeyEvent: () => false,
    pasteClipboardText: vi.fn(),
    sendInput: vi.fn(),
    getShortcutContext: () => ({
      clientPlatform: 'darwin',
      macOptionAsAlt: 'false',
      keybindings: undefined,
      terminalInput: null,
      getKittyKeyboardFlags: () => 31,
      terminalShortcutPolicy: undefined
    })
  })
  return (event) => handler!(event)
}

describe('preview terminal key handler — macOS native-menu chords', () => {
  it.each([
    ['Cmd+Q', { key: 'q', code: 'KeyQ', metaKey: true }],
    ['Cmd+H', { key: 'h', code: 'KeyH', metaKey: true }],
    ['Cmd+Option+H', { key: 'h', code: 'KeyH', metaKey: true, altKey: true }],
    ['Cmd+M', { key: 'm', code: 'KeyM', metaKey: true }]
  ])('keeps %s out of xterm without consuming it', (_name, init) => {
    const handle = installHandler()
    const keydown = new KeyboardEvent('keydown', { ...init, cancelable: true })

    expect(handle(keydown)).toBe(false)
    expect(keydown.defaultPrevented).toBe(false)
  })

  it('keeps the Cmd+Q release out of xterm', () => {
    const handle = installHandler()
    const keyup = new KeyboardEvent('keyup', { key: 'q', code: 'KeyQ', metaKey: true })

    expect(handle(keyup)).toBe(false)
  })

  it('still lets xterm encode Cmd+Comma for terminal apps', () => {
    const handle = installHandler()
    const keydown = new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true })

    expect(handle(keydown)).toBe(true)
  })
})
