import { useAppStore } from '@/store'
import { botThreadOpenRevision } from '@/lib/agent-session/open/bot-thread-open-lifecycle'

/** Whether the user moved to another workspace, view or host, picked a workspace still being
 *  created, or opened a bot thread link, since a bot open was asked for. */
export type BotOpenIntent = {
  /** True once any such move happened, even if the window later came back. */
  moved: () => boolean
  /** True once a thread link began opening since the ask. Still read after `stop`, which ends only
   *  the selection watch: the open's own Home switch must not count, but a newer link always wins. */
  linkOpened: () => boolean
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
  const links = botThreadOpenRevision()
  const linkOpened = (): boolean => botThreadOpenRevision() !== links
  let moved = false
  let unsubscribe: (() => void) | null = store.subscribe(() => {
    if (workspaceKey(store.getState()) !== asked) {
      moved = true
      unsubscribe?.()
      unsubscribe = null
    }
  })
  return {
    moved: () => moved || linkOpened(),
    linkOpened,
    stop: () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}
