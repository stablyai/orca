// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'
import { installTerminalLinkPtyMouseSuppression } from '../terminal-pane/terminal-link-pty-mouse-suppression'

const platform = vi.hoisted(() => {
  const value: { value: NodeJS.Platform } = { value: 'win32' }
  return value
})
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platform.value }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: {} }) } }))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose()
  }
})

it.each(['win32', 'linux', 'darwin'] as const)(
  'records native key origin without changing the existing %s custom-handler result/default/propagation/bytes',
  (os) => {
    platform.value = os
    const element = document.createElement('div')
    const terminal = new Terminal()
    const owner = installTerminalLinkPtyMouseSuppression(
      { element, clearSelection: () => {} },
      { candidate: () => 'link', eligible: () => true, canContinue: () => true }
    )
    owner.bindSource({ isCurrent: () => true, user: () => {}, unclassified: () => {} })
    let custom: (event: KeyboardEvent) => boolean = () => {
      throw new Error('Missing production key handler')
    }
    const attachment = vi
      .spyOn(terminal, 'attachCustomKeyEventHandler')
      .mockImplementation((handler) => {
        custom = handler
      })
    const sendInput = vi.fn()
    const keyOrigin = vi.fn(owner.recordKeyEvent)
    const install = (observe: boolean) =>
      installPreviewTerminalKeyHandler({
        terminal,
        onKeyEvent: observe ? keyOrigin : undefined,
        claimImeKeyEvent: () => false,
        pasteClipboardText: () => {},
        sendInput,
        getShortcutContext: () => ({
          clientPlatform: os,
          macOptionAsAlt: 'false',
          keybindings: {},
          terminalInput: null,
          getKittyKeyboardFlags: () => 0
        })
      })
    const nativePhase = os === 'win32' ? 'keyup' : 'keydown'
    const baseline = install(false)
    const outcomes = (key: string, type: string, shiftKey = false) => {
      const event = new KeyboardEvent(type, { key, shiftKey, cancelable: true })
      const stop = vi.spyOn(event, 'stopPropagation')
      const immediate = vi.spyOn(event, 'stopImmediatePropagation')
      const result = custom(event)
      return {
        result,
        prevented: event.defaultPrevented,
        stop: stop.mock.calls.length,
        immediate: immediate.mock.calls.length
      }
    }
    const before = [outcomes('ContextMenu', nativePhase), outcomes('F10', 'keydown', true)]
    const baselineBytes = sendInput.mock.calls.slice()
    baseline()
    sendInput.mockClear()
    const observed = install(true)
    cleanup.push(() => {
      observed()
      owner.dispose()
      attachment.mockRestore()
      terminal.dispose()
    })
    expect([outcomes('ContextMenu', nativePhase), outcomes('F10', 'keydown', true)]).toEqual(before)
    expect(sendInput.mock.calls).toEqual(baselineBytes)
    expect(keyOrigin).toHaveBeenCalledTimes(2)
    const operation = vi.fn()
    if (os === 'darwin') {
      // F10 is not a native origin on Mac; refresh the actual ContextMenu origin.
      outcomes('ContextMenu', nativePhase)
    }
    expect(
      owner.commitKeyboard(
        new MouseEvent('contextmenu', { button: -1, buttons: 0, cancelable: true }),
        operation
      )
    ).toBe(true)
    expect(operation).toHaveBeenCalledOnce()
    expect(owner.commitKeyboard(new MouseEvent('contextmenu', { button: -1 }), operation)).toBe(
      false
    )
  }
)
