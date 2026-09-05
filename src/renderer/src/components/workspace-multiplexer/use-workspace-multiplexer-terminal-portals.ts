import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  TAB_GROUP_SPLIT_CREATED_EVENT,
  type TabGroupSplitCreatedDetail
} from '@/store/slices/tabs/tab-group-split-event'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  WorkspaceMultiplexerSlot,
  WorkspaceMultiplexerState
} from '../../../../shared/workspace-multiplexer-types'
import {
  setTerminalSurfacePortals,
  type TerminalSurfacePortalTarget
} from '../activity/activity-terminal-portal'
import {
  insertWorkspaceMultiplexerSlot,
  removeWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'
import {
  findWorkspaceMultiplexerCatalogItem,
  findWorkspaceMultiplexerSlotTerminalTab,
  workspaceMultiplexerOwnsTerminalTabs,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'

export function useWorkspaceMultiplexerTerminalPortals(args: {
  slots: readonly WorkspaceMultiplexerSlot[]
  focusedSlotId: string | null
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
  unifiedTabsByWorktree: ReturnType<typeof useAppStore.getState>['unifiedTabsByWorktree']
  restoredSessionHosts: ReturnType<
    typeof useAppStore.getState
  >['restoredRuntimeHostIdByWorkspaceSessionKey']
  terminalTabsByWorktree: Record<string, TerminalTab[]>
}): (slotId: string, element: HTMLDivElement | null) => void {
  const [targets, setTargets] = useState<ReadonlyMap<string, HTMLDivElement>>(new Map())
  const setTarget = useCallback((slotId: string, element: HTMLDivElement | null) => {
    setTargets((current) => {
      if (current.get(slotId) === element || (!element && !current.has(slotId))) {
        return current
      }
      const next = new Map(current)
      if (element) {
        next.set(slotId, element)
      } else {
        next.delete(slotId)
      }
      return next
    })
  }, [])
  const descriptors = useMemo<TerminalSurfacePortalTarget[]>(
    () =>
      args.slots.flatMap((slot) => {
        const target = targets.get(slot.id)
        const workspace = findWorkspaceMultiplexerCatalogItem(args.catalog, slot)
        const unifiedTabs = args.unifiedTabsByWorktree[slot.worktreeId] ?? []
        const unifiedTerminalExists =
          findWorkspaceMultiplexerSlotTerminalTab(slot, unifiedTabs) !== undefined
        const terminalExists = (args.terminalTabsByWorktree[slot.worktreeId] ?? []).some(
          (tab) => tab.id === slot.activeTerminalTabId
        )
        if (
          !target ||
          !workspace ||
          !slot.activeTerminalTabId ||
          !unifiedTerminalExists ||
          !terminalExists ||
          !workspaceMultiplexerOwnsTerminalTabs(
            workspace,
            unifiedTabs,
            args.restoredSessionHosts[slot.worktreeId]
          )
        ) {
          return []
        }
        return [
          {
            slotId: `multiplexer:${slot.id}`,
            requestToken: `multiplexer:${slot.id}:${slot.activeTerminalTabId}`,
            target,
            worktreeId: slot.worktreeId,
            tabId: slot.activeTerminalTabId,
            active: slot.id === args.focusedSlotId
          }
        ]
      }),
    [
      args.catalog,
      args.focusedSlotId,
      args.restoredSessionHosts,
      args.slots,
      args.terminalTabsByWorktree,
      args.unifiedTabsByWorktree,
      targets
    ]
  )
  useLayoutEffect(() => setTerminalSurfacePortals(descriptors), [descriptors])
  return setTarget
}

export function useWorkspaceMultiplexerSplitEvents(
  setFocusedSlotId: (slotId: string) => void,
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
): void {
  useEffect(() => {
    const handleSplit = (event: Event): void => {
      const detail = (event as CustomEvent<TabGroupSplitCreatedDetail>).detail
      const state = useAppStore.getState()
      const multiplexer = state.workspaceMultiplexer
      const source = multiplexer.slots.find(
        (slot) => slot.worktreeId === detail.worktreeId && slot.groupId === detail.sourceGroupId
      )
      const target = multiplexer.slots.find(
        (slot) => slot.worktreeId === detail.worktreeId && slot.groupId === detail.targetGroupId
      )
      if (
        !source ||
        !target ||
        multiplexer.slots.some(
          (slot) => slot.groupId === detail.newGroupId && slot.worktreeId === detail.worktreeId
        )
      ) {
        return
      }
      const tabs = state.unifiedTabsByWorktree[detail.worktreeId] ?? []
      const sourceWorkspace = findWorkspaceMultiplexerCatalogItem(catalog, source)
      const targetWorkspace = findWorkspaceMultiplexerCatalogItem(catalog, target)
      if (
        !sourceWorkspace ||
        sourceWorkspace.identity !== targetWorkspace?.identity ||
        !workspaceMultiplexerOwnsTerminalTabs(
          sourceWorkspace,
          tabs,
          state.restoredRuntimeHostIdByWorkspaceSessionKey[detail.worktreeId]
        )
      ) {
        return
      }
      const moved = tabs.find(
        (tab) => tab.id === detail.unifiedTabId && tab.contentType === 'terminal'
      )
      if (!moved) {
        return
      }
      const sourceGroup = (state.groupsByWorktree[detail.worktreeId] ?? []).find(
        (group) => group.id === detail.sourceGroupId
      )
      const sourceTerminals = tabs.filter(
        (tab) => tab.groupId === detail.sourceGroupId && tab.contentType === 'terminal'
      )
      const sourceFallback =
        sourceTerminals.find((tab) => tab.id === sourceGroup?.activeTabId) ?? sourceTerminals[0]
      const sourceUpdated: WorkspaceMultiplexerState = sourceGroup
        ? {
            ...multiplexer,
            slots: multiplexer.slots.map((slot) =>
              slot.id === source.id
                ? { ...slot, activeTerminalTabId: sourceFallback?.entityId ?? null }
                : slot
            )
          }
        : removeWorkspaceMultiplexerSlot(multiplexer, source.id)
      const newSlot: WorkspaceMultiplexerSlot = {
        id: createBrowserUuid(),
        worktreeId: source.worktreeId,
        executionHostId: source.executionHostId,
        groupId: detail.newGroupId,
        activeTerminalTabId: moved.entityId
      }
      state.setWorkspaceMultiplexer(
        insertWorkspaceMultiplexerSlot(sourceUpdated, newSlot, target.id, detail.direction)
      )
      setFocusedSlotId(newSlot.id)
    }
    window.addEventListener(TAB_GROUP_SPLIT_CREATED_EVENT, handleSplit)
    return () => window.removeEventListener(TAB_GROUP_SPLIT_CREATED_EVENT, handleSplit)
  }, [catalog, setFocusedSlotId])
}
