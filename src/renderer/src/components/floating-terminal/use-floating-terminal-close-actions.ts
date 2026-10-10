import { useCallback } from 'react'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import { useTabGroupCloseScopeCommands } from '@/components/tab-group/useTabGroupCloseScopeCommands'
import { useTabGroupTabCloseCommands } from '@/components/tab-group/useTabGroupTabCloseCommands'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FloatingWorkspaceChromeModel } from './use-floating-workspace-chrome-model'

type FloatingTerminalCloseActionsInput = Pick<
  FloatingWorkspaceChromeModel,
  'activeGroup' | 'groupTabs'
>

export function useFloatingTerminalCloseActions({
  activeGroup,
  groupTabs
}: FloatingTerminalCloseActionsInput) {
  const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
  const { closeItem, closeMany } = useTabGroupTabCloseCommands({ worktreeId })
  const scope = useTabGroupCloseScopeCommands({
    groupId: activeGroup?.id ?? '',
    worktreeId,
    group: activeGroup,
    groupTabs,
    closeItem,
    closeMany
  })
  const resolveItemId = useCallback(
    (visibleId: string) => resolveGroupTabFromVisibleId(groupTabs, visibleId)?.id ?? null,
    [groupTabs]
  )

  const closeFloatingItemConfirmed = useCallback(
    (visibleId: string, options?: { guestOwned?: boolean }) => {
      const tabId = resolveItemId(visibleId)
      if (tabId) {
        dispatchWorkspaceTabCommand({
          type: 'close',
          target: { kind: 'tab', worktreeId, tabId },
          floatingPanelGuestOwned: options?.guestOwned === true
        })
      }
    },
    [resolveItemId, worktreeId]
  )
  const closeOthers = useCallback(
    (visibleId: string) => {
      const tabId = resolveItemId(visibleId)
      if (tabId) {
        scope.closeOthers(tabId)
      }
    },
    [resolveItemId, scope]
  )
  const closeToRight = useCallback(
    (visibleId: string) => {
      const tabId = resolveItemId(visibleId)
      if (tabId) {
        scope.closeToRight(tabId)
      }
    },
    [resolveItemId, scope]
  )
  const closeToLeft = useCallback(
    (visibleId: string) => {
      const tabId = resolveItemId(visibleId)
      if (tabId) {
        scope.closeToLeft(tabId)
      }
    },
    [resolveItemId, scope]
  )

  return {
    closeFloatingItemConfirmed,
    closeOthers,
    closeToRight,
    closeToLeft,
    closeAllFiles: scope.closeAllEditorTabsInGroup
  }
}

export type FloatingTerminalCloseActions = ReturnType<typeof useFloatingTerminalCloseActions>
