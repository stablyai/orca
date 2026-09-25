import { useMemo } from 'react'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useTabGroupWorkspaceModel } from '@/components/tab-group/useTabGroupWorkspaceModel'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { resolveFloatingWorkspaceSurfaceModel } from './floating-workspace-surface-model'

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []

/**
 * Shell chrome model for the floating panel: the shared per-group workspace model of the
 * FOCUSED floating group, plus the derived fields the panel's titlebar strip, shortcuts,
 * close policy and focus lifecycle read. The panel body renders every group through the
 * shared tree; only the shell's one titlebar strip needs a focused-group projection.
 */
export function useFloatingWorkspaceChromeModel() {
  const surface = useAppStore(useShallow(resolveFloatingWorkspaceSurfaceModel))
  const focusedGroupId = surface.kind === 'workspace' ? surface.focusedGroupId : ''
  const model = useTabGroupWorkspaceModel({
    groupId: focusedGroupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID
  })
  const { activeTab, group, groupTabs } = model
  // Why filtered: the strip and the emptiness decision only count tabs whose terminal entity
  // still exists — a stale unified entry must fall back to the empty state, not a blank pane.
  const terminalEntities = useAppStore(
    (state) => state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  )
  const terminalItems = useMemo(() => {
    const entityIds = new Set(terminalEntities.map((tab) => tab.id))
    return model.terminalTabs.filter((item) => entityIds.has(item.id))
  }, [model.terminalTabs, terminalEntities])

  const activeTerminalId = activeTab?.contentType === 'terminal' ? activeTab.entityId : null
  const activeBrowserId = activeTab?.contentType === 'browser' ? activeTab.entityId : null
  const activeEditorUnifiedId =
    activeTab &&
    activeTab.contentType !== 'terminal' &&
    activeTab.contentType !== 'browser' &&
    activeTab.contentType !== 'simulator' &&
    activeTab.contentType !== 'agent-session'
      ? activeTab.id
      : null
  const activeBrowserTab = activeBrowserId
    ? (model.browserItems.find((item) => item.id === activeBrowserId) ?? null)
    : null
  const activeEditorFile = activeEditorUnifiedId
    ? (model.editorItems.find((item) => item.tabId === activeEditorUnifiedId) ?? null)
    : null
  const activeTabType: 'browser' | 'terminal' | 'simulator' | 'editor' | 'agent-session' =
    activeTab?.contentType === 'browser'
      ? 'browser'
      : activeTab?.contentType === 'terminal'
        ? 'terminal'
        : activeTab?.contentType === 'agent-session'
          ? 'agent-session'
          : activeTab?.contentType === 'simulator'
            ? 'simulator'
            : 'editor'

  const hasVisibleFloatingTabs = surface.kind === 'workspace'

  // Visible-id order for tab-cycling shortcuts: strip order restricted to entries whose entity
  // still resolves, so a shortcut never lands on a tab the strip is not showing.
  const visibleFloatingTabOrder = useMemo(
    () =>
      model.tabBarOrder.filter((visibleId) => {
        const tab = resolveGroupTabFromVisibleId(groupTabs, visibleId)
        if (!tab) {
          return false
        }
        if (tab.contentType === 'terminal') {
          return terminalItems.some((item) => item.unifiedTabId === tab.id)
        }
        if (tab.contentType === 'browser') {
          return model.browserItems.some((item) => item.tabId === tab.id)
        }
        if (tab.contentType === 'simulator' || tab.contentType === 'agent-session') {
          return true
        }
        return model.editorItems.some((item) => item.tabId === tab.id)
      }),
    [groupTabs, model.browserItems, model.editorItems, model.tabBarOrder, terminalItems]
  )
  const activeClosableTab =
    activeTab &&
    visibleFloatingTabOrder.includes(
      activeTab.contentType === 'terminal' || activeTab.contentType === 'browser'
        ? activeTab.entityId
        : activeTab.id
    )
      ? activeTab
      : null

  return {
    surface,
    model,
    terminalItems,
    activeGroup: group,
    groupTabs,
    activeTab,
    activeTerminalId,
    activeBrowserId,
    activeEditorUnifiedId,
    activeBrowserTab,
    activeEditorFile,
    activeTabType,
    activeClosableTab,
    hasVisibleFloatingTabs,
    visibleFloatingTabOrder
  }
}

export type FloatingWorkspaceChromeModel = ReturnType<typeof useFloatingWorkspaceChromeModel>
