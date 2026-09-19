// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

const goBackWorktree = vi.fn()
const goForwardWorktree = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ goBackWorktree, goForwardWorktree })
  }
}))

import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'

function dispatchContext() {
  return {
    tabId: 'tab',
    worktreeId: 'wt',
    fallbackCwd: '/tmp',
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
    managerRef: { current: null },
    getKeyboardSplitTelemetrySource: () => 'keyboard' as const,
    armNativeOnlyShortcut: vi.fn()
  }
}

function twoPaneManager(): { manager: PaneManager; root: HTMLDivElement } {
  const root = document.createElement('div')
  root.className = 'pane-split is-vertical'
  const paneA = document.createElement('div')
  paneA.className = 'pane'
  const divider = document.createElement('div')
  divider.className = 'pane-divider is-vertical'
  const paneB = document.createElement('div')
  paneB.className = 'pane'
  root.append(paneA, divider, paneB)
  document.body.append(root)
  paneA.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 })
  paneB.getBoundingClientRect = () => DOMRect.fromRect({ x: 110, y: 0, width: 100, height: 100 })
  const panes = [
    { id: 1, container: paneA },
    { id: 2, container: paneB }
  ]
  const setActivePane = vi.fn()
  const stub = {
    getPanes: () => panes,
    getActivePane: () => panes[0],
    setActivePane
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spatial dispatch only reads getPanes/getActivePane/setActivePane; extra PaneManager methods must fail if touched.
  const manager = stub as unknown as PaneManager
  return { root, manager }
}

describe('dispatchTerminalShortcutAction spatial focus', () => {
  it('moves to a neighbor without worktree history', () => {
    goBackWorktree.mockClear()
    goForwardWorktree.mockClear()
    const { manager, root } = twoPaneManager()
    const event = new KeyboardEvent('keydown', { cancelable: true })

    dispatchTerminalShortcutAction(
      { type: 'focusPane', direction: 'right' },
      event,
      manager,
      dispatchContext()
    )

    expect(manager.setActivePane).toHaveBeenCalledWith(2, { focus: true })
    expect(goBackWorktree).not.toHaveBeenCalled()
    expect(goForwardWorktree).not.toHaveBeenCalled()
    root.remove()
  })

  it('dispatches worktree history at a layout edge', () => {
    goBackWorktree.mockClear()
    goForwardWorktree.mockClear()
    const { manager, root } = twoPaneManager()
    const event = new KeyboardEvent('keydown', { cancelable: true })

    dispatchTerminalShortcutAction(
      { type: 'focusPane', direction: 'left' },
      event,
      manager,
      dispatchContext()
    )

    expect(manager.setActivePane).not.toHaveBeenCalled()
    expect(goBackWorktree).toHaveBeenCalledTimes(1)
    expect(goForwardWorktree).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    root.remove()
  })
})
