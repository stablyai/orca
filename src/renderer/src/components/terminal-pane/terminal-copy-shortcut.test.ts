// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

type DispatchContext = Parameters<typeof dispatchTerminalShortcutAction>[3]

function dispatchCopy(selection: string, repeat: boolean) {
  const writeTerminalClipboardText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeTerminalClipboardText } })
  const tracker = createTerminalNativeOnlyShortcutTracker()
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    code: 'KeyC',
    metaKey: true,
    repeat,
    cancelable: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copy only reads the active pane's selection.
  const manager = {
    getActivePane: () => ({ terminal: { getSelection: () => selection } })
  } as PaneManager
  const context: DispatchContext = {
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
  return {
    claimed: event.defaultPrevented,
    copies: writeTerminalClipboardText.mock.calls.length,
    releaseClaimed: tracker.consumeCompanion({ type: 'keyup', key: 'c', code: 'KeyC' })
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('terminal copy shortcut', () => {
  it('leaves an unselected press to the terminal', () => {
    expect(dispatchCopy('', false)).toEqual({ claimed: false, copies: 0, releaseClaimed: false })
  })

  it('copies a selection once and claims the press through its release', () => {
    expect(dispatchCopy('text', false)).toEqual({ claimed: true, copies: 1, releaseClaimed: true })
    expect(dispatchCopy('text', true)).toEqual({ claimed: true, copies: 0, releaseClaimed: false })
  })

  it('matches held and remapped copy bindings', () => {
    const keybindings = { 'terminal.copySelection': ['Mod+Shift+C'] }
    const chord = {
      key: 'c',
      code: 'KeyC',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(resolveTerminalShortcutAction(chord, true, 'false', 0, false, keybindings)).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        { ...chord, shiftKey: true, repeat: true },
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'copySelection' })
  })
})
