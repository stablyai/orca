import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  collectWorkspaceViewPanels,
  resolveWorkspaceViewTab,
  selectShownWorkspaceView
} from './workspace-view-catalog'
import { focusWorkspaceViewPanel } from './workspace-view-actions'

function selectedTab(state: AppState) {
  const workspaceId = state.activeWorktreeId
  if (!workspaceId) {
    return null
  }
  const groupId = state.activeGroupIdByWorktree[workspaceId]
  const group = state.groupsByWorktree[workspaceId]?.find((group) => group.id === groupId)
  return (
    state.unifiedTabsByWorktree[workspaceId]?.find((tab) => tab.id === group?.activeTabId) ?? null
  )
}

export function subscribeWorkspaceViewSelection(): () => void {
  let reconciling = false
  let recoveringClose = false
  let disposed = false
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (
      reconciling ||
      recoveringClose ||
      next.activeView !== 'terminal' ||
      !next.activeWorkspaceViewId ||
      next.activeWorkspaceViewId !== previous.activeWorkspaceViewId
    ) {
      return
    }
    const view = next.workspaceViews.find((view) => view.id === next.activeWorkspaceViewId)
    if (!view) {
      return
    }
    const before = selectedTab(previous),
      selected = selectedTab(next)
    if (
      before?.id === selected?.id &&
      previous.activeWorktreeId === next.activeWorktreeId &&
      previous.activeWorkspaceExecutionHostId === next.activeWorkspaceExecutionHostId
    ) {
      return
    }
    reconciling = true
    try {
      if (
        view.panels.length &&
        next.activeWorktreeId &&
        !view.panels.some((panel) => panel.workspaceId === next.activeWorktreeId)
      ) {
        next.selectWorkspaceView(null)
        return
      }
      if (!selected) {
        return
      }
      const existing = view.panels.find(
        (panel) =>
          panel.workspaceId === selected.worktreeId &&
          panel.tabId === selected.id &&
          resolveWorkspaceViewTab(next, panel)
      )
      if (existing) {
        next.setWorkspaceViewFocus(existing.id)
        return
      }
      if (
        before &&
        !next.unifiedTabsByWorktree[before.worktreeId]?.some((tab) => tab.id === before.id)
      ) {
        recoveringClose = true
        // A close finishes its own fallback selection before a surviving view panel takes focus.
        queueMicrotask(() => {
          try {
            if (disposed) {
              return
            }
            const state = useAppStore.getState()
            const current = selectShownWorkspaceView(state)
            if (current?.id !== view.id) {
              return
            }
            const remaining = current.panels.find((panel) => resolveWorkspaceViewTab(state, panel))
            if (remaining) {
              focusWorkspaceViewPanel(remaining.id, true)
            }
          } finally {
            recoveringClose = false
          }
        })
        return
      }
      if (!selectShownWorkspaceView(previous) || before?.worktreeId !== selected.worktreeId) {
        return
      }
      const focused = view.panels.find(
        (panel) => panel.id === view.focusedPanelId && panel.workspaceId === selected.worktreeId
      )
      const target = collectWorkspaceViewPanels(next).find(
        (panel) => panel.workspaceId === selected.worktreeId && panel.tabId === selected.id
      )
      if (focused && target) {
        next.addWorkspaceViewPanel(target, focused.id)
      }
    } finally {
      reconciling = false
    }
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}

export function useWorkspaceViewSelection(ready: boolean): void {
  useEffect(() => (ready ? subscribeWorkspaceViewSelection() : undefined), [ready])
}
