import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import type { WorkspaceMultiplexerSlot } from '../../../../shared/workspace-multiplexer-types'
import {
  findWorkspaceMultiplexerPaneForSlot,
  insertWorkspaceMultiplexerSlot,
  removeWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'
import {
  findWorkspaceMultiplexerCatalogItem,
  findWorkspaceMultiplexerSlotTerminalTab,
  selectWorkspaceMultiplexerGroup,
  workspaceMultiplexerOwnsTerminalTabs,
  workspaceMultiplexerSlotIdentity,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'

export function useWorkspaceMultiplexerPageActions(
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
): {
  focusedSlotId: string | null
  setFocusedSlotId: Dispatch<SetStateAction<string | null>>
  expandedPaneId: string | null
  setExpandedPaneId: Dispatch<SetStateAction<string | null>>
  focusSlot: (
    slot: WorkspaceMultiplexerSlot,
    workspace: WorkspaceMultiplexerCatalogItem | null
  ) => boolean
  focusWorkspaceSlot: (slotId: string) => void
  addWorkspace: (workspace: WorkspaceMultiplexerCatalogItem, sourceSlotId?: string | null) => void
  removeWorkspace: (slotId: string) => void
} {
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(
    useAppStore.getState().workspaceMultiplexer.slots[0]?.id ?? null
  )
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null)
  const focusSlot = useCallback(
    (slot: WorkspaceMultiplexerSlot, workspace: WorkspaceMultiplexerCatalogItem | null) => {
      setFocusedSlotId(slot.id)
      if (!workspace) {
        return false
      }
      let state = useAppStore.getState()
      if (
        !workspaceMultiplexerOwnsTerminalTabs(
          workspace,
          state.unifiedTabsByWorktree[slot.worktreeId] ?? [],
          state.restoredRuntimeHostIdByWorkspaceSessionKey[slot.worktreeId]
        )
      ) {
        return false
      }
      state.setActiveWorktree(slot.worktreeId, workspace.executionHostId)
      state = useAppStore.getState()
      if (
        !workspaceMultiplexerOwnsTerminalTabs(
          workspace,
          state.unifiedTabsByWorktree[slot.worktreeId] ?? [],
          state.restoredRuntimeHostIdByWorkspaceSessionKey[slot.worktreeId]
        )
      ) {
        return false
      }
      if (slot.groupId) {
        state.focusGroup(slot.worktreeId, slot.groupId)
      }
      const terminalTab = findWorkspaceMultiplexerSlotTerminalTab(
        slot,
        state.unifiedTabsByWorktree[slot.worktreeId] ?? []
      )
      if (terminalTab) {
        state.activateTab(terminalTab.id, { worktreeId: slot.worktreeId })
        state.setActiveTab(terminalTab.entityId)
        state.setActiveTabType('terminal')
      }
      return true
    },
    []
  )
  const focusWorkspaceSlot = useCallback(
    (slotId: string) => {
      const slot = useAppStore
        .getState()
        .workspaceMultiplexer.slots.find((item) => item.id === slotId)
      if (slot) {
        focusSlot(slot, findWorkspaceMultiplexerCatalogItem(catalog, slot))
      }
    },
    [catalog, focusSlot]
  )
  const addWorkspace = useCallback(
    (workspace: WorkspaceMultiplexerCatalogItem, sourceSlotId?: string | null): void => {
      let state = useAppStore.getState()
      if (
        !workspaceMultiplexerOwnsTerminalTabs(
          workspace,
          state.unifiedTabsByWorktree[workspace.worktreeId] ?? [],
          state.restoredRuntimeHostIdByWorkspaceSessionKey[workspace.worktreeId]
        )
      ) {
        return
      }
      state.setActiveWorktree(workspace.worktreeId, workspace.executionHostId)
      state = useAppStore.getState()
      if (
        !workspaceMultiplexerOwnsTerminalTabs(
          workspace,
          state.unifiedTabsByWorktree[workspace.worktreeId] ?? [],
          state.restoredRuntimeHostIdByWorkspaceSessionKey[workspace.worktreeId]
        )
      ) {
        return
      }
      const multiplexer = state.workspaceMultiplexer
      const representedGroups = new Set(
        multiplexer.slots
          .filter((slot) => workspaceMultiplexerSlotIdentity(slot) === workspace.identity)
          .map((slot) => slot.groupId)
      )
      const groups = state.groupsByWorktree[workspace.worktreeId] ?? []
      const selection = selectWorkspaceMultiplexerGroup({
        groups,
        tabs: state.unifiedTabsByWorktree[workspace.worktreeId] ?? [],
        representedGroupIds: representedGroups,
        activeGroupId: state.activeGroupIdByWorktree[workspace.worktreeId] ?? null
      })
      let groupId = selection?.groupId ?? null
      if (!groupId && representedGroups.size > 0) {
        const sourceGroupId =
          state.activeGroupIdByWorktree[workspace.worktreeId] ??
          groups[0]?.id ??
          state.ensureWorktreeRootGroup(workspace.worktreeId)
        groupId = state.createEmptySplitGroup(workspace.worktreeId, sourceGroupId, 'right')
        if (!groupId) {
          return
        }
      }
      groupId ??= state.ensureWorktreeRootGroup(workspace.worktreeId)
      state = useAppStore.getState()
      const group = (state.groupsByWorktree[workspace.worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      const tabs = state.unifiedTabsByWorktree[workspace.worktreeId] ?? []
      const terminalTab =
        tabs.find(
          (tab) =>
            tab.groupId === groupId &&
            tab.contentType === 'terminal' &&
            tab.entityId === selection?.activeTerminalTabId
        ) ??
        tabs.find(
          (tab) =>
            tab.groupId === groupId &&
            tab.contentType === 'terminal' &&
            tab.id === group?.activeTabId
        ) ??
        tabs.find((tab) => tab.groupId === groupId && tab.contentType === 'terminal')
      const slot: WorkspaceMultiplexerSlot = {
        id: createBrowserUuid(),
        worktreeId: workspace.worktreeId,
        executionHostId: workspace.executionHostId,
        groupId,
        activeTerminalTabId: terminalTab?.entityId ?? null
      }
      state.setWorkspaceMultiplexer(
        insertWorkspaceMultiplexerSlot(
          multiplexer,
          slot,
          sourceSlotId ?? focusedSlotId ?? multiplexer.slots[0]?.id ?? null
        )
      )
      if (focusSlot(slot, workspace) && !terminalTab) {
        void useAppStore.getState().openNewTerminalTabInActiveWorkspace(groupId)
      }
    },
    [focusSlot, focusedSlotId]
  )
  const removeWorkspace = useCallback((slotId: string): void => {
    const state = useAppStore.getState()
    const sourcePane = findWorkspaceMultiplexerPaneForSlot(state.workspaceMultiplexer, slotId)
    const next = removeWorkspaceMultiplexerSlot(state.workspaceMultiplexer, slotId)
    state.setWorkspaceMultiplexer(next)
    setExpandedPaneId((current) =>
      current && next.panes.some((pane) => pane.id === current) ? current : null
    )
    setFocusedSlotId((current) =>
      current === slotId
        ? (next.panes.find((pane) => pane.id === sourcePane?.id)?.activeSlotId ??
          next.panes[0]?.activeSlotId ??
          null)
        : current
    )
  }, [])

  return {
    focusedSlotId,
    setFocusedSlotId,
    expandedPaneId,
    setExpandedPaneId,
    focusSlot,
    focusWorkspaceSlot,
    addWorkspace,
    removeWorkspace
  }
}
