// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

function createContext(searchOpen: boolean) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Search dispatch does not access the manager; an unexpected access must fail the test.
  const manager = {} as PaneManager
  const context: Parameters<typeof dispatchTerminalShortcutAction>[3] = {
    tabId: 'tab-1',
    worktreeId: 'folder-1',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: searchOpen },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    managerRef: { current: manager },
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: vi.fn()
  }
  return { manager, context }
}

describe('terminal find shortcut dispatch', () => {
  it.each([true, false])('opens then refocuses without closing (isMac=%s)', (isMac) => {
    const { manager, context } = createContext(false)
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: isMac,
      ctrlKey: !isMac,
      cancelable: true
    })
    const action = resolveTerminalShortcutAction(event, isMac)
    expect(action).toEqual({ type: 'toggleSearch' })
    if (!action) {
      throw new Error('Expected the terminal search shortcut')
    }
    dispatchTerminalShortcutAction(action, event, manager, context)
    expect(context.setSearchOpen).toHaveBeenCalledWith(true)
    expect(context.focusSearchInput).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    vi.mocked(context.setSearchOpen).mockClear()
    context.searchOpenRef.current = true
    dispatchTerminalShortcutAction(action, event, manager, context)
    expect(context.focusSearchInput).toHaveBeenCalledTimes(1)
    expect(context.setSearchOpen).not.toHaveBeenCalled()
  })

  it('ignores physical key repeat', () => {
    const { manager, context } = createContext(true)
    dispatchTerminalShortcutAction(
      { type: 'toggleSearch' },
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, repeat: true }),
      manager,
      context
    )
    expect(context.focusSearchInput).not.toHaveBeenCalled()
    expect(context.setSearchOpen).not.toHaveBeenCalled()
  })
})
