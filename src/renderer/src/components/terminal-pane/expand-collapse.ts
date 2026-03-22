import type { PaneManager } from '@/lib/pane-manager/pane-manager'

type ExpandCollapseState = {
  expandedPaneIdRef: React.MutableRefObject<number | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  containerRef: React.RefObject<HTMLDivElement | null>
  managerRef: React.RefObject<PaneManager | null>
  setExpandedPaneId: (paneId: number | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  tabId: string
  persistLayoutSnapshot: () => void
}

function rememberPaneStyle(
  snapshots: Map<HTMLElement, { display: string; flex: string }>,
  el: HTMLElement
): void {
  if (snapshots.has(el)) {
    return
  }
  snapshots.set(el, { display: el.style.display, flex: el.style.flex })
}

export function restoreExpandedLayoutFrom(
  snapshots: Map<HTMLElement, { display: string; flex: string }>
): void {
  for (const [el, prev] of snapshots.entries()) {
    el.style.display = prev.display
    el.style.flex = prev.flex
  }
  snapshots.clear()
}

export function applyExpandedLayoutTo(
  paneId: number,
  state: Pick<ExpandCollapseState, 'managerRef' | 'containerRef' | 'expandedStyleSnapshotRef'>
): boolean {
  const manager = state.managerRef.current
  const root = state.containerRef.current
  if (!manager || !root) {
    return false
  }

  const panes = manager.getPanes()
  if (panes.length <= 1) {
    return false
  }
  const targetPane = panes.find((pane) => pane.id === paneId)
  if (!targetPane) {
    return false
  }

  restoreExpandedLayoutFrom(state.expandedStyleSnapshotRef.current)
  const snapshots = state.expandedStyleSnapshotRef.current
  let current: HTMLElement | null = targetPane.container
  while (current && current !== root) {
    const parent = current.parentElement
    if (!parent) {
      break
    }
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) {
        continue
      }
      rememberPaneStyle(snapshots, child)
      if (child === current) {
        child.style.display = ''
        child.style.flex = '1 1 auto'
      } else {
        child.style.display = 'none'
      }
    }
    current = parent
  }
  return true
}

export function createExpandCollapseActions(state: ExpandCollapseState) {
  const setExpandedPane = (paneId: number | null): void => {
    state.expandedPaneIdRef.current = paneId
    state.setExpandedPaneId(paneId)
    state.setTabPaneExpanded(state.tabId, paneId !== null)
    state.persistLayoutSnapshot()
  }

  const restoreExpandedLayout = (): void => {
    restoreExpandedLayoutFrom(state.expandedStyleSnapshotRef.current)
  }

  const refreshPaneSizes = (focusActive: boolean): void => {
    requestAnimationFrame(() => {
      const manager = state.managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      for (const p of panes) {
        try {
          p.fitAddon.fit()
        } catch {
          /* container may not have dimensions */
        }
      }
      if (focusActive) {
        const active = manager.getActivePane() ?? panes[0]
        active?.terminal.focus()
      }
    })
  }

  const syncExpandedLayout = (): void => {
    const paneId = state.expandedPaneIdRef.current
    if (paneId === null) {
      restoreExpandedLayout()
      return
    }

    const manager = state.managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length <= 1 || !panes.some((pane) => pane.id === paneId)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      return
    }
    applyExpandedLayoutTo(paneId, state)
  }

  const toggleExpandPane = (paneId: number): void => {
    const manager = state.managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length <= 1) {
      return
    }

    const isAlreadyExpanded = state.expandedPaneIdRef.current === paneId
    if (isAlreadyExpanded) {
      setExpandedPane(null)
      restoreExpandedLayout()
      refreshPaneSizes(true)
      state.persistLayoutSnapshot()
      return
    }

    setExpandedPane(paneId)
    if (!applyExpandedLayoutTo(paneId, state)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      state.persistLayoutSnapshot()
      return
    }
    manager.setActivePane(paneId, { focus: true })
    refreshPaneSizes(true)
    state.persistLayoutSnapshot()
  }

  return {
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  }
}
