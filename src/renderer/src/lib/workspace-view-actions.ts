import { workspaceViewAnchorId } from './workspace-view-layout'
import type { WorkspaceViewPlacement } from '@/components/workspace-grid-view/workspace-view-projection'
import { useAppStore } from '@/store'
import { resolveWorkspaceViewTab } from './workspace-view-catalog'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { activateTerminalTabOnOwner } from './terminal-tab-owner-activation'
import { toVisibleTabType } from '../../../shared/tab-types'

export function focusWorkspaceViewPanel(panelId: string, focusContent = false): boolean {
  const state = useAppStore.getState()
  const view = state.workspaceViews.find((view) => view.id === state.activeWorkspaceViewId)
  const panel = view?.panels.find((panel) => panel.id === panelId)
  if (!panel) {
    return false
  }
  const tab = resolveWorkspaceViewTab(state, panel)
  if (!tab) {
    return false
  }
  if (
    state.activeWorktreeId !== panel.workspaceId ||
    state.activeWorkspaceExecutionHostId !== panel.executionHostId
  ) {
    if (
      !state.setActiveWorktree(panel.workspaceId, panel.executionHostId, {
        preserveTerminalSessions: true,
        stateTransition: (current) => ({
          activate: resolveWorkspaceViewTab(current, panel) !== null,
          patch: {},
          preferredActiveUnifiedTabId: tab.id
        })
      })
    ) {
      return false
    }
  }
  const current = useAppStore.getState()
  if (!resolveWorkspaceViewTab(current, panel)) {
    return false
  }
  const alreadyFocused =
    view?.focusedPanelId === panelId &&
    current.getActiveTab(panel.workspaceId)?.id === tab.id &&
    current.activeWorktreeId === panel.workspaceId
  current.setWorkspaceViewFocus(panelId)
  if (!alreadyFocused) {
    current.focusGroup(panel.workspaceId, tab.groupId)
    current.activateTab(tab.id, { worktreeId: panel.workspaceId, preservePreview: true })
    current.setActiveTabType(toVisibleTabType(tab.contentType), panel.workspaceId)
    if (tab.contentType === 'terminal') {
      current.setActiveTab(tab.entityId)
    } else if (tab.contentType === 'browser') {
      current.setActiveBrowserTab(tab.entityId, panel.workspaceId)
    } else if (toVisibleTabType(tab.contentType) === 'editor') {
      current.setActiveFile(tab.entityId, panel.workspaceId)
      current.activateTab(tab.id, { worktreeId: panel.workspaceId, preservePreview: true })
    }
  }
  if (tab.contentType === 'terminal') {
    if (!alreadyFocused) {
      activateTerminalTabOnOwner(
        panel.workspaceId,
        tab.entityId,
        current.terminalLayoutsByTabId[tab.entityId]?.activeLeafId ?? null
      )
    }
    if (focusContent) {
      focusTerminalTabSurface(
        tab.entityId,
        current.terminalLayoutsByTabId[tab.entityId]?.activeLeafId,
        {
          immediate: true,
          onlyWithinTab: true,
          shouldFocus: () => {
            const next = useAppStore.getState()
            return (
              next.activeWorktreeId === panel.workspaceId &&
              next.activeWorkspaceExecutionHostId === panel.executionHostId &&
              next.workspaceViewPicker === null &&
              !document.querySelector(
                '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'
              ) &&
              next.workspaceViews.find((view) => view.id === next.activeWorkspaceViewId)
                ?.focusedPanelId === panelId
            )
          }
        }
      )
    }
  }
  return true
}

export function showWorkspaceView(viewId: string): void {
  const state = useAppStore.getState()
  const view = state.workspaceViews.find((view) => view.id === viewId)
  if (!view) {
    return
  }
  state.selectWorkspaceView(viewId)
  state.setActiveView('terminal')
  const selected =
    view.panels.find(
      (panel) => panel.id === view.focusedPanelId && resolveWorkspaceViewTab(state, panel)
    ) ?? view.panels.find((panel) => resolveWorkspaceViewTab(state, panel))
  if (selected) {
    focusWorkspaceViewPanel(selected.id, true)
  } else if (view.panels.length) {
    state.setActiveWorktree(null)
  }
}

export function removeWorkspaceViewPanelKeepingFocus(panelId: string): void {
  const state = useAppStore.getState()
  state.removeWorkspaceViewPanel(panelId)
  const next = useAppStore.getState()
  const view = next.workspaceViews.find((view) => view.id === next.activeWorkspaceViewId)
  const panel = view?.panels.find((panel) => panel.id === view.focusedPanelId)
  if (panel) {
    focusWorkspaceViewPanel(panel.id, true)
  }
}

export function focusWorkspaceViewAnchor(
  projection: readonly WorkspaceViewPlacement[] | null,
  anchorId: string
): boolean {
  const placement = projection?.find((item) => workspaceViewAnchorId(item.panel.id) === anchorId)
  if (!placement) {
    return false
  }
  focusWorkspaceViewPanel(placement.panel.id)
  return true
}
