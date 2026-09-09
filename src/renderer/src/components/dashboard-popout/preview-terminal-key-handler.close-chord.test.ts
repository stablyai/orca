// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const platformState = vi.hoisted(() => ({ value: 'darwin' as NodeJS.Platform }))
const storeState = vi.hoisted(() => ({ keybindings: {} as Record<string, string[]> }))

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platformState.value
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (s: typeof storeState) => unknown): unknown => selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'

function installHandler(requestClose: () => void): {
  handler: (event: KeyboardEvent) => boolean
  sendInput: ReturnType<typeof vi.fn>
  dispose: () => void
} {
  let handler: ((event: KeyboardEvent) => boolean) | null = null
  const terminal = {
    attachCustomKeyEventHandler: (fn: (event: KeyboardEvent) => boolean) => {
      handler = fn
    },
    getSelection: () => '',
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
    selectAll: vi.fn()
  } as unknown as Terminal
  const sendInput = vi.fn()
  const dispose = installPreviewTerminalKeyHandler({
    terminal,
    claimImeKeyEvent: () => false,
    pasteClipboardText: () => {},
    sendInput,
    requestClose,
    getShortcutContext: () => ({
      clientPlatform: platformState.value,
      macOptionAsAlt: 'false',
      keybindings: storeState.keybindings,
      terminalInput: null,
      getKittyKeyboardFlags: () => 0,
      terminalShortcutPolicy: 'orca-first'
    })
  })
  return { handler: handler!, sendInput, dispose }
}

let disposeHandler: (() => void) | null = null

beforeEach(() => {
  platformState.value = 'darwin'
  storeState.keybindings = {}
})

afterEach(() => {
  disposeHandler?.()
  disposeHandler = null
})

// Why: the preview auto-focuses its terminal, and xterm swallows Escape and Tab,
// so the pane-close chord is the only keyboard exit from the dialog.
describe('preview terminal close chord', () => {
  it('closes the hosting surface on the tab-close chord instead of swallowing it', () => {
    const requestClose = vi.fn()
    const { handler, dispose } = installHandler(requestClose)
    disposeHandler = dispose

    const event = new KeyboardEvent('keydown', { key: 'w', metaKey: true, cancelable: true })
    expect(handler(event)).toBe(false)

    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves ordinary typing to the terminal', () => {
    const requestClose = vi.fn()
    const { handler, dispose } = installHandler(requestClose)
    disposeHandler = dispose

    expect(handler(new KeyboardEvent('keydown', { key: 'w' }))).toBe(true)
    expect(requestClose).not.toHaveBeenCalled()
  })
})
