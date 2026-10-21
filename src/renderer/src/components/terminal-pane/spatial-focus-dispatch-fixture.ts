import { vi, type Mock, type MockInstance } from 'vitest'
import { PaneManager, type ManagedPane } from '@/lib/pane-manager/pane-manager'
import { createExpandCollapseActions } from './expand-collapse'
import type { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'

function ref<T>(current: T) {
  return { current }
}

type SpatialFocusFixture = {
  root: HTMLDivElement
  manager: PaneManager
  first: ManagedPane
  second: ManagedPane
  divider: HTMLElement
  state: Parameters<typeof createExpandCollapseActions>[0] & {
    persistLayoutSnapshot: Mock<() => void>
    setExpandedPaneId: Mock<(paneId: number | null) => void>
    setTabPaneExpanded: Mock<(tabId: string, expanded: boolean) => void>
  }
  context: Parameters<typeof dispatchTerminalShortcutAction>[3]
  setActivePane: MockInstance<PaneManager['setActivePane']>
  expand: () => void
  dispose: () => void
}

export function createSpatialFocusFixture(vertical = true): SpatialFocusFixture {
  const root = document.createElement('div')
  document.body.append(root)
  const manager = new PaneManager(root, { linkOpenHint: () => '' })
  const first = manager.createInitialPane()
  manager.splitPane(first.id, vertical ? 'vertical' : 'horizontal')
  const second = manager.getPanes().find((pane) => pane.id !== first.id)
  if (!second) {
    throw new Error('Expected split pane')
  }
  manager.setActivePane(first.id, { focus: false })
  const divider = root.querySelector<HTMLElement>('.pane-divider')
  if (!divider) {
    throw new Error('Expected divider')
  }
  first.container.getBoundingClientRect = () => DOMRect.fromRect({ width: 100, height: 100 })
  second.container.getBoundingClientRect = () => {
    if (second.container.style.display === 'none') {
      return DOMRect.fromRect()
    }
    const gap = Number.parseFloat(vertical ? divider.style.width : divider.style.height)
    return DOMRect.fromRect({
      x: vertical ? 100 + gap : 0,
      y: vertical ? 0 : 100 + gap,
      width: 100,
      height: 100
    })
  }
  const state = {
    expandedPaneIdRef: ref<number | null>(null),
    expandedStyleSnapshotRef: {
      current: new Map<HTMLElement, { display: string; flex: string }>()
    },
    containerRef: { current: root },
    managerRef: { current: manager },
    pendingPaneSizeRefreshFrameIdsRef: ref<number[]>([]),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    tabId: 'tab',
    persistLayoutSnapshot: vi.fn()
  }
  const actions = createExpandCollapseActions(state)
  const setActivePane = vi.spyOn(manager, 'setActivePane')
  const context: Parameters<typeof dispatchTerminalShortcutAction>[3] = {
    ...actions,
    shortcutPlatform: 'linux',
    tabId: 'tab',
    worktreeId: 'wt',
    fallbackCwd: '/tmp',
    expandedPaneIdRef: state.expandedPaneIdRef,
    persistLayoutSnapshot: state.persistLayoutSnapshot,
    refreshPaneSizes: vi.fn(actions.refreshPaneSizes),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: false },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    managerRef: state.managerRef,
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: vi.fn()
  }
  function expand() {
    actions.toggleExpandPane(first.id)
    state.persistLayoutSnapshot.mockClear()
    state.setExpandedPaneId.mockClear()
    state.setTabPaneExpanded.mockClear()
    setActivePane.mockClear()
    state.pendingPaneSizeRefreshFrameIdsRef.current = []
    vi.mocked(context.refreshPaneSizes).mockClear()
  }
  return {
    root,
    manager,
    first,
    second,
    divider,
    state,
    context,
    setActivePane,
    expand,
    dispose: () => {
      manager.destroy()
      root.remove()
    }
  }
}
