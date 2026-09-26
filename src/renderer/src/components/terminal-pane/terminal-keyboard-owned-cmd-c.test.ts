// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

describe('Orca-owned Cmd+C lifecycle', () => {
  it('keeps a remapped action repeat and release out of xterm', () => {
    const scope = document.createElement('div')
    const terminalElement = document.createElement('div')
    const textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    terminalElement.appendChild(textarea)
    scope.appendChild(terminalElement)
    document.body.appendChild(scope)

    const terminal = { element: terminalElement, focus: vi.fn() }
    const pane = { id: 1, terminal }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane],
      equalizePaneSizes: vi.fn()
    }
    const nativeOnlyShortcutTracker = createTerminalNativeOnlyShortcutTracker()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the complete equalize-pane path; unused runtime dependencies remain absent.
    const handlers = createTerminalKeyboardEventHandlers({
      isMac: true,
      isWindows: false,
      shortcutPlatform: 'darwin',
      keyboardScopeRef: { current: scope },
      managerRef: { current: manager },
      resolveShortcutEvent: (event: { repeat: boolean }) =>
        event.repeat ? null : { type: 'equalizePaneSizes' },
      nativeOnlyShortcutTracker,
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      expandedPaneIdRef: { current: null },
      keybindings: undefined,
      terminalShortcutPolicy: 'orca-first'
    } as never)

    const leaked: string[] = []
    textarea.addEventListener('keydown', (event) => leaked.push(event.repeat ? 'repeat' : 'press'))
    textarea.addEventListener('keyup', () => leaked.push('release'))
    window.addEventListener('keydown', handlers.onKeyDown, { capture: true })
    window.addEventListener('keyup', handlers.onNativeOnlyShortcutCompanion, { capture: true })
    const key = (type: 'keydown' | 'keyup', repeat = false) =>
      textarea.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'c',
          code: 'KeyC',
          metaKey: true,
          repeat,
          bubbles: true,
          cancelable: true
        })
      )
    try {
      key('keydown')
      key('keydown', true)
      key('keyup')
      expect(manager.equalizePaneSizes).toHaveBeenCalledOnce()
      expect(leaked).toEqual([])
    } finally {
      window.removeEventListener('keydown', handlers.onKeyDown, { capture: true })
      window.removeEventListener('keyup', handlers.onNativeOnlyShortcutCompanion, { capture: true })
      scope.remove()
    }
  })

  it('leaves native input-source key repeats to the OS', () => {
    const scope = document.createElement('div')
    const textarea = document.createElement('textarea')
    scope.appendChild(textarea)
    document.body.appendChild(scope)
    const nativeOnlyShortcutTracker = createTerminalNativeOnlyShortcutTracker()
    nativeOnlyShortcutTracker.armKeyDown({ key: ' ', code: 'Space' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a consumed repeat would return before this fixture's unused manager path.
    const handlers = createTerminalKeyboardEventHandlers({
      isMac: true,
      keyboardScopeRef: { current: scope },
      managerRef: { current: null },
      nativeOnlyShortcutTracker
    } as never)
    window.addEventListener('keydown', handlers.onKeyDown, { capture: true })
    try {
      const repeat = new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        shiftKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true
      })
      textarea.dispatchEvent(repeat)
      expect(repeat.defaultPrevented).toBe(false)
    } finally {
      window.removeEventListener('keydown', handlers.onKeyDown, { capture: true })
      scope.remove()
    }
  })
})
