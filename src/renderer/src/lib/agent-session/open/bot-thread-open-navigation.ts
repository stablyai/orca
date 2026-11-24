import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { cancelPendingBotThreadOpen } from './bot-thread-open-lifecycle'

export type BotThreadNavigate = <T>(action: () => T) => T

function changedSelection(state: AppState, previous: AppState): boolean {
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
  const currentId = state.groupsByWorktree[workspace]?.find(
    (group) => group.id === currentGroup
  )?.activeTabId
  const previousId = previous.groupsByWorktree[workspace]?.find(
    (group) => group.id === previousGroup
  )?.activeTabId
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
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!navigating && changedSelection(state, previous)) {
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
