import { useCallback } from 'react'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import {
  countVisibleFloatingWorkspaceItems,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import { armFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { useAppStore } from '@/store'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import type { Tab } from '../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FloatingTerminalEditorCloseQueue } from './use-floating-terminal-editor-close-queue'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

type FloatingTerminalCloseActionsInput = Pick<
  FloatingTerminalPanelStoreState,
  'closeTab' | 'closeBrowserTab' | 'closeFile' | 'closeUnifiedTab'
> &
  Pick<FloatingTerminalPanelItems, 'activeGroup' | 'groupTabs'> &
  Pick<FloatingTerminalPanelLocalState, 'pendingReclaimArmByFileIdRef'> &
  Pick<FloatingTerminalEditorCloseQueue, 'queueEditorCloseRequests'>

export function useFloatingTerminalCloseActions({
  closeTab,
  closeBrowserTab,
  closeFile,
  closeUnifiedTab,
  activeGroup,
  groupTabs,
  pendingReclaimArmByFileIdRef,
  queueEditorCloseRequests
}: FloatingTerminalCloseActionsInput) {
  const closeFloatingItems = useCallback(
    (visibleIds: string[]) => {
      const state = useAppStore.getState()
      const currentGroupTabs = activeGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === activeGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const items = visibleIds
        .map((visibleId) => resolveGroupTabFromVisibleId(currentGroupTabs, visibleId))
        .filter((item): item is Tab => item !== null && !item.isPinned)
      if (items.length === 0) {
        return
      }
      const dirtyEditorFileIds: string[] = []
      for (const item of items) {
        if (item.contentType === 'terminal') {
          closeTab(item.entityId, { reason: 'cleanup' })
        } else if (item.contentType === 'browser') {
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
        } else if (item.contentType === 'simulator') {
          closeUnifiedTab(item.id)
        } else {
          const file = state.openFiles.find((candidate) => candidate.id === item.entityId)
          if (file?.isDirty) {
            dirtyEditorFileIds.push(item.entityId)
            continue
          }
          closeFile(item.entityId)
        }
      }
      if (dirtyEditorFileIds.length > 0) {
        queueEditorCloseRequests(dirtyEditorFileIds)
      }
    },
    [activeGroup, closeBrowserTab, closeFile, closeTab, closeUnifiedTab, queueEditorCloseRequests]
  )

  const closeFloatingItemConfirmed = useCallback(
    (visibleId: string, options?: { guestOwned?: boolean }) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
      if (!item) {
        return
      }
      const panelOwnedNow = options?.guestOwned === true || isFloatingWorkspacePanelFocused()
      const itemCountBeforeClose = countVisibleFloatingWorkspaceItems(useAppStore.getState())
      const armIfEmptying = (): void => {
        if (!panelOwnedNow) {
          return
        }
        const itemCountAfterClose = countVisibleFloatingWorkspaceItems(useAppStore.getState())
        if (itemCountAfterClose === 0 && itemCountAfterClose < itemCountBeforeClose) {
          armFloatingPanelReclaimIntent()
        }
      }
      if (item.contentType === 'terminal') {
        closeTerminalTab(item.entityId, { onClosed: armIfEmptying })
        return
      }
      const state = useAppStore.getState()
      guardPinnedTabClose({
        isPinned: item.isPinned === true,
        tabLabel: resolvePinnedTabLabel(state, FLOATING_TERMINAL_WORKTREE_ID, visibleId),
        onClose: () => {
          const latest = useAppStore.getState()
          if (item.contentType === 'browser') {
            destroyWorkspaceWebviews(latest.browserPagesByWorkspace, item.entityId)
            closeBrowserTab(item.entityId)
          } else if (item.contentType === 'simulator') {
            closeUnifiedTab(item.id)
          } else {
            const file = latest.openFiles.find((candidate) => candidate.id === item.entityId)
            if (file?.isDirty) {
              pendingReclaimArmByFileIdRef.current.set(item.entityId, armIfEmptying)
              queueEditorCloseRequests([item.entityId])
              return
            }
            closeFile(item.entityId)
          }
          armIfEmptying()
        }
      })
    },
    [
      closeBrowserTab,
      closeFile,
      closeUnifiedTab,
      groupTabs,
      pendingReclaimArmByFileIdRef,
      queueEditorCloseRequests
    ]
  )

  const closeOthers = useCallback(
    (visibleId: string) => {
      const state = useAppStore.getState()
      const currentGroupTabs = activeGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === activeGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const item = resolveGroupTabFromVisibleId(currentGroupTabs, visibleId)
      if (!item) {
        return
      }
      closeFloatingItems(
        currentGroupTabs.filter((tab) => tab.id !== item.id && !tab.isPinned).map((tab) => tab.id)
      )
    },
    [activeGroup, closeFloatingItems]
  )

  const closeToSide = useCallback(
    (visibleId: string, side: 'left' | 'right') => {
      const state = useAppStore.getState()
      const currentGroup = activeGroup
        ? state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
            (group) => group.id === activeGroup.id
          )
        : null
      const currentGroupTabs = currentGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === currentGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const item = resolveGroupTabFromVisibleId(currentGroupTabs, visibleId)
      if (!item || !currentGroup) {
        return
      }
      const index = currentGroup.tabOrder.indexOf(item.id)
      if (index === -1) {
        return
      }
      const sideIds =
        side === 'right'
          ? currentGroup.tabOrder.slice(index + 1)
          : currentGroup.tabOrder.slice(0, index)
      const tabById = new Map(currentGroupTabs.map((tab) => [tab.id, tab]))
      closeFloatingItems(
        sideIds.filter((tabId) => {
          const tab = tabById.get(tabId)
          return tab ? !tab.isPinned : false
        })
      )
    },
    [activeGroup, closeFloatingItems]
  )

  const closeToRight = useCallback(
    (visibleId: string) => closeToSide(visibleId, 'right'),
    [closeToSide]
  )
  const closeToLeft = useCallback(
    (visibleId: string) => closeToSide(visibleId, 'left'),
    [closeToSide]
  )

  const closeAllFiles = useCallback(() => {
    const state = useAppStore.getState()
    const currentGroupTabs = activeGroup
      ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
          (tab) => tab.groupId === activeGroup.id
        )
      : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
    closeFloatingItems(
      currentGroupTabs
        .filter(
          (tab) =>
            tab.contentType !== 'terminal' &&
            tab.contentType !== 'browser' &&
            tab.contentType !== 'simulator' &&
            !tab.isPinned
        )
        .map((tab) => tab.id)
    )
  }, [activeGroup, closeFloatingItems])

  return {
    closeFloatingItemConfirmed,
    closeOthers,
    closeToRight,
    closeToLeft,
    closeAllFiles
  }
}

export type FloatingTerminalCloseActions = ReturnType<typeof useFloatingTerminalCloseActions>
