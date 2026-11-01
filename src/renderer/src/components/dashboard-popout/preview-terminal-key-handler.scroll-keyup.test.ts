// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: {} }) } }))
vi.mock(import('@/lib/keyboard-layout/layout-base-character'), async (importOriginal) => ({
  ...(await importOriginal()),
  prefetchLayoutCharacters: vi.fn()
}))

const { installPreviewTerminalKeyHandler } = await import('./preview-terminal-key-handler')

function installHarness() {
  let keyHandler: ((event: KeyboardEvent) => boolean) | null = null
  const terminalStub = {
    attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
      keyHandler = handler
    },
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scrollViewport path only calls these three members.
  const terminal = terminalStub as unknown as Terminal
  const dispose = installPreviewTerminalKeyHandler({
    terminal,
    claimImeKeyEvent: () => false,
    pasteClipboardText: vi.fn(),
    sendInput: vi.fn(),
    getShortcutContext: () => ({
      clientPlatform: 'darwin',
      macOptionAsAlt: 'false',
      keybindings: undefined,
      terminalInput: null,
      getKittyKeyboardFlags: () => 3,
      terminalShortcutPolicy: undefined
    })
  })
  const pressKey = (event: KeyboardEvent): boolean => {
    if (!keyHandler) {
      throw new Error('key handler not attached')
    }
    return keyHandler(event)
  }
  return { terminalStub, dispose, pressKey }
}

describe('preview terminal scroll shortcut keyup ownership (#17606)', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
    document.body.replaceChildren()
  })

  it('keeps the Cmd+ArrowUp keyup away from xterm', () => {
    const harness = installHarness()
    dispose = harness.dispose
    const keyDown = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      metaKey: true,
      cancelable: true
    })
    expect(harness.pressKey(keyDown)).toBe(false)
    expect(harness.terminalStub.scrollToTop).toHaveBeenCalledTimes(1)

    // Stands in for xterm's textarea keyup listener, below the window capture phase.
    const xtermTextarea = document.createElement('textarea')
    document.body.append(xtermTextarea)
    const xtermKeyUp = vi.fn()
    xtermTextarea.addEventListener('keyup', xtermKeyUp)
    const keyUp = (): KeyboardEvent =>
      new KeyboardEvent('keyup', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true })

    xtermTextarea.dispatchEvent(keyUp())
    expect(xtermKeyUp).not.toHaveBeenCalled()
    // Only the one keyup is owned; the next release is ordinary input again.
    xtermTextarea.dispatchEvent(keyUp())
    expect(xtermKeyUp).toHaveBeenCalledTimes(1)
  })
})
