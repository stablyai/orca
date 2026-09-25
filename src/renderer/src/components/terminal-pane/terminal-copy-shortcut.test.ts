// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

const writeClipboardText = vi.fn().mockResolvedValue(undefined)
afterEach(() => vi.unstubAllGlobals())

describe('terminal copy shortcut ownership', () => {
  it.each(['', 'selected text'])('claims copy only with a selection: %j', (selection) => {
    writeClipboardText.mockClear()
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeTerminalClipboardText: writeClipboardText } }
    })
    const tracker = createTerminalNativeOnlyShortcutTracker()
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      metaKey: true,
      cancelable: true
    })
    const pane = { terminal: { getSelection: () => selection } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copy only reads the active pane's selection and arms the supplied shortcut tracker.
    const manager = { getActivePane: () => pane } as Parameters<
      typeof dispatchTerminalShortcutAction
    >[2]
    const context: Parameters<typeof dispatchTerminalShortcutAction>[3] = {
      tabId: 'tab',
      worktreeId: 'workspace',
      fallbackCwd: '',
      expandedPaneIdRef: { current: null },
      setExpandedPane: vi.fn(),
      restoreExpandedLayout: vi.fn(),
      refreshPaneSizes: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      toggleExpandPane: vi.fn(),
      setSearchOpen: vi.fn(),
      focusSearchInput: vi.fn(),
      searchOpenRef: { current: false },
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: vi.fn(),
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      paneTransportsRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      managerRef: { current: manager },
      getKeyboardSplitTelemetrySource: () => 'keyboard',
      armNativeOnlyShortcut: tracker.armKeyDown
    }
    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)
    expect(writeClipboardText).toHaveBeenCalledTimes(selection ? 1 : 0)
    expect(event.defaultPrevented).toBe(Boolean(selection))
    expect(tracker.consumeCompanion({ type: 'keyup', key: 'c', code: 'KeyC' })).toBe(
      Boolean(selection)
    )
  })

  it('respects a remapped copy binding', () => {
    const bindings = { 'terminal.copySelection': ['Mod+Shift+C'] }
    const event = {
      key: 'c',
      code: 'KeyC',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(resolveTerminalShortcutAction(event, true, 'false', 0, false, bindings)).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        { ...event, shiftKey: true, repeat: true },
        true,
        'false',
        0,
        false,
        bindings
      )
    ).toEqual({ type: 'copySelection' })
  })
})
