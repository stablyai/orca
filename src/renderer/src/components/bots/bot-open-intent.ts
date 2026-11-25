import { useAppStore } from '@/store'

/** Whether the user moved to another workspace, view or host, or picked a workspace still being
 *  created, since a bot open was asked for. */
export type BotOpenIntent = {
  /** True once any such move happened, even if the window later came back. */
  moved: () => boolean
  stop: () => void
}

type WorkspaceSelection = {
  activeView: string
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  /** A pending-creation row shows its own panel over the workspace selection, which stays put. */
  activePendingCreationId: string | null
}

function workspaceKey(state: WorkspaceSelection): string {
  return [
    state.activeView,
    state.activeWorkspaceKey ?? state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId,
    state.activePendingCreationId
  ].join('\0')
}

/**
 * Starts at the user's click and watches only workspace-level selection: a server's tab frames
 * change tabs inside a workspace, never which workspace is shown, so they can't count as a move.
 */
export function watchBotOpenIntent(
  store: {
    getState: () => WorkspaceSelection
    subscribe: (listener: () => void) => () => void
  } = useAppStore
): BotOpenIntent {
  const asked = workspaceKey(store.getState())
  let moved = false
  let unsubscribe: (() => void) | null = store.subscribe(() => {
    if (workspaceKey(store.getState()) !== asked) {
      moved = true
      unsubscribe?.()
      unsubscribe = null
    }
  })
  return {
    moved: () => moved,
    stop: () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}
