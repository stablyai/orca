import { useMemo } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'

type ExpandCollapseState = {
  expandedPaneIdRef: React.MutableRefObject<number | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  containerRef: React.RefObject<HTMLDivElement | null>
  managerRef: React.RefObject<PaneManager | null>
  setExpandedPaneId: (paneId: number | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  pendingPaneSizeRefreshFrameIdsRef: React.MutableRefObject<number[]>
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
        // Preserve inline display:flex because clearing it collapses split layout and breaks FitAddon measurement.
        child.style.flex = '1 1 auto'
      } else {
        child.style.display = 'none'
      }
    }
    current = parent
  }
  return true
}

export function cancelPendingPaneSizeRefreshFrames(
  state: Pick<ExpandCollapseState, 'pendingPaneSizeRefreshFrameIdsRef'>
): void {
  for (const frameId of state.pendingPaneSizeRefreshFrameIdsRef.current) {
    cancelAnimationFrame(frameId)
  }
  state.pendingPaneSizeRefreshFrameIdsRef.current = []
}

function requestPaneSizeRefreshFrame(
  state: ExpandCollapseState,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      state.pendingPaneSizeRefreshFrameIdsRef.current =
        state.pendingPaneSizeRefreshFrameIdsRef.current.filter(
          (pendingFrameId) => pendingFrameId !== frameId
        )
    }
    callback(timestamp)
  })
  if (!completed) {
    state.pendingPaneSizeRefreshFrameIdsRef.current.push(frameId)
  }
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

  // Fit after rAF settles ancestor display/flex changes; safeFit owns scroll preservation to avoid matching duplicate scrollback lines.
  const refreshPaneSizes = (focusActive: boolean): void => {
    requestPaneSizeRefreshFrame(state, () => {
      const manager = state.managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      for (const p of panes) {
        safeFit(p)
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

// Keep keyboard-effect dependencies stable so expand/collapse cannot reinstall window listeners on every render.
export function useExpandCollapseActions(state: ExpandCollapseState) {
  const {
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    containerRef,
    managerRef,
    setExpandedPaneId,
    setTabPaneExpanded,
    pendingPaneSizeRefreshFrameIdsRef,
    tabId,
    persistLayoutSnapshot
  } = state
  return useMemo(
    () =>
      createExpandCollapseActions({
        expandedPaneIdRef,
        expandedStyleSnapshotRef,
        containerRef,
        managerRef,
        setExpandedPaneId,
        setTabPaneExpanded,
        pendingPaneSizeRefreshFrameIdsRef,
        tabId,
        persistLayoutSnapshot
      }),
    [
      expandedPaneIdRef,
      expandedStyleSnapshotRef,
      containerRef,
      managerRef,
      setExpandedPaneId,
      setTabPaneExpanded,
      pendingPaneSizeRefreshFrameIdsRef,
      tabId,
      persistLayoutSnapshot
    ]
  )
}
