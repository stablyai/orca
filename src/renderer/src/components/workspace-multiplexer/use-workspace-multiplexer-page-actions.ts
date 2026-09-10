import { useCallback, useEffect, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { WorkspaceMultiplexerSlot } from '../../../../shared/workspace-multiplexer-types'
import {
  activateWorkspaceMultiplexerSlot,
  findWorkspaceMultiplexerPaneForSlot,
  insertWorkspaceMultiplexerSlot,
  removeWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'
import {
  buildWorkspaceMultiplexerCatalog,
  findWorkspaceMultiplexerCatalogItem,
  findWorkspaceMultiplexerSlotTerminalTab,
  selectWorkspaceMultiplexerGroup,
  workspaceMultiplexerOwnsTerminalTabs,
  workspaceMultiplexerSlotIdentity,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'
import {
  WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT,
  type WorkspaceMultiplexerAddRequestDetail
} from './workspace-multiplexer-add-request'

export function useWorkspaceMultiplexerPageActions(
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
) {
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(
    () => useAppStore.getState().workspaceMultiplexer.panes[0]?.activeSlotId ?? null
  )
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null)
  const focusSlot = useCallback(
    (slot: WorkspaceMultiplexerSlot, workspace: WorkspaceMultiplexerCatalogItem | null) => {
      setFocusedSlotId(slot.id)
      const pane = findWorkspaceMultiplexerPaneForSlot(
        useAppStore.getState().workspaceMultiplexer,
        slot.id
      )
      setExpandedPaneId((current) => (current === pane?.id ? current : null))
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
      const state = useAppStore.getState()
      const slot = state.workspaceMultiplexer.slots.find((item) => item.id === slotId)
      if (slot) {
        const pane = findWorkspaceMultiplexerPaneForSlot(state.workspaceMultiplexer, slotId)
        if (pane && pane.activeSlotId !== slotId) {
          state.setWorkspaceMultiplexer(
            activateWorkspaceMultiplexerSlot(state.workspaceMultiplexer, pane.id, slotId)
          )
        }
        focusSlot(slot, findWorkspaceMultiplexerCatalogItem(catalog, slot))
      }
    },
    [catalog, focusSlot]
  )
  const addWorkspace = useCallback(
    (
      workspace: WorkspaceMultiplexerCatalogItem,
      sourceSlotId?: string | null,
      direction: TabSplitDirection = 'right'
    ): void => {
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
          sourceSlotId ?? focusedSlotId ?? multiplexer.slots[0]?.id ?? null,
          direction
        )
      )
      if (focusSlot(slot, workspace) && !terminalTab) {
        void useAppStore.getState().openNewTerminalTabInActiveWorkspace(groupId)
      }
    },
    [focusSlot, focusedSlotId]
  )
  useEffect(() => {
    const handleAddRequest = (event: Event): void => {
      const { worktreeId, executionHostId, terminal } = (
        event as CustomEvent<WorkspaceMultiplexerAddRequestDetail>
      ).detail
      const state = useAppStore.getState()
      const workspace = buildWorkspaceMultiplexerCatalog({
        worktrees: getAllWorktreesFromState(state),
        folderWorkspaces: state.folderWorkspaces,
        repos: state.repos,
        projectGroups: state.projectGroups
      }).find(
        (item) =>
          item.worktreeId === worktreeId &&
          (!executionHostId || item.executionHostId === executionHostId)
      )
      if (
        !workspace ||
        !workspaceMultiplexerOwnsTerminalTabs(
          workspace,
          state.unifiedTabsByWorktree[worktreeId] ?? [],
          state.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]
        )
      ) {
        return
      }
      const terminalTab =
        terminal &&
        (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === terminal.tabId
        )
      if (terminal && !terminalTab) {
        return
      }
      const matchingSlots = state.workspaceMultiplexer.slots.filter(
        (slot) => workspaceMultiplexerSlotIdentity(slot) === workspace.identity
      )
      const groupId = terminalTab?.groupId ?? state.activeGroupIdByWorktree[worktreeId]
      const existingSlot =
        matchingSlots.find((slot) => slot.groupId === groupId) ??
        (terminal ? undefined : matchingSlots[0])
      if (terminalTab) {
        state.focusGroup(worktreeId, terminalTab.groupId)
        state.activateTab(terminalTab.id, { worktreeId })
        if (existingSlot) {
          state.setWorkspaceMultiplexer({
            ...state.workspaceMultiplexer,
            slots: state.workspaceMultiplexer.slots.map((slot) =>
              slot.id === existingSlot.id
                ? { ...slot, activeTerminalTabId: terminalTab.entityId }
                : slot
            )
          })
        }
      }
      if (existingSlot) {
        focusWorkspaceSlot(existingSlot.id)
      } else {
        addWorkspace(workspace)
      }
      if (terminal) {
        activateTabAndFocusPane(terminal.tabId, terminal.leafId, terminal)
        focusTerminalTabSurface(terminal.tabId, terminal.leafId)
      }
    }
    window.addEventListener(WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT, handleAddRequest)
    return () =>
      window.removeEventListener(WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT, handleAddRequest)
  }, [addWorkspace, focusWorkspaceSlot])
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
