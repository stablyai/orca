import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { cancelPendingBotThreadOpen } from './bot-thread-open-lifecycle'

export type BotThreadNavigate = <T>(action: () => T) => T

type GroupTabId = (
  groups: AppState['groupsByWorktree'][string] | undefined,
  groupId: string | undefined
) => string | null | undefined

function changedSelection(state: AppState, previous: AppState, groupTabId: GroupTabId): boolean {
  const { activeWorktreeId: workspace } = state
  if (
    workspace !== previous.activeWorktreeId ||
    state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
    state.activeView !== previous.activeView
  ) {
    return true
  }
  if (
    !workspace ||
    state.activeView !== 'terminal' ||
    (state.groupsByWorktree[workspace] === previous.groupsByWorktree[workspace] &&
      state.activeGroupIdByWorktree[workspace] === previous.activeGroupIdByWorktree[workspace])
  ) {
    return false
  }
  const previousGroup = previous.activeGroupIdByWorktree[workspace]
  const currentGroup = state.activeGroupIdByWorktree[workspace]
  const groups = state.groupsByWorktree[workspace]
  const previousGroups = previous.groupsByWorktree[workspace]
  // Focusing an existing split changes its group selection without rebuilding its tabs.
  if (
    previousGroup &&
    currentGroup &&
    previousGroup !== currentGroup &&
    groups === previousGroups
  ) {
    return true
  }
  const previousId = groupTabId(previousGroups, previousGroup)
  const currentId = groupTabId(groups, currentGroup)
  if (!currentId || (currentId === previousId && currentGroup === previousGroup)) {
    return false
  }
  const active = state.unifiedTabsByWorktree[workspace]?.find((tab) => tab.id === currentId)
  // A mirror can supply the first visible tab. Only a new local focus visit competes with the link.
  return (
    active?.lastFocusedAt !== undefined &&
    active.lastFocusedAt !==
      previous.unifiedTabsByWorktree[workspace]?.find((tab) => tab.id === active.id)?.lastFocusedAt
  )
}

export async function withBotThreadOpenNavigation(
  signal: AbortSignal,
  open: (navigate: BotThreadNavigate) => Promise<void>
): Promise<void> {
  let navigating = false
  let groupIndex = 0
  const groupTabId: GroupTabId = (groups, groupId) => {
    if (!groups || !groupId) {
      return
    }
    // Reordering tabs in another group keeps the selected group's position.
    if (groups[groupIndex]?.id !== groupId) {
      groupIndex = groups.findIndex((group) => group.id === groupId)
    }
    return groups[groupIndex]?.activeTabId
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!navigating && changedSelection(state, previous, groupTabId)) {
      cancelPendingBotThreadOpen()
    }
  })
  signal.addEventListener('abort', unsubscribe, { once: true })
  try {
    await open((action) => {
      navigating = true
      try {
        return action()
      } finally {
        navigating = false
      }
    })
  } finally {
    unsubscribe()
    signal.removeEventListener('abort', unsubscribe)
  }
}
