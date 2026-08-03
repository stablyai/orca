import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '../../store'
import { getRuntimeEnvironmentIdForWorktree } from '../../lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session'
import {
  getLatestWebSessionTabsPublicationEpoch,
  subscribeWebSessionTabsPublication
} from '../../runtime/web-session-tabs-sync'

/**
 * A group sits at zero tabs in two very different situations, and only one of
 * them is "empty". `ensureWorktreeRootGroup` creates the root group before any
 * tab exists; locally the auto-create effect fills it in the same effect flush,
 * but a runtime-owned worktree defers to the host's session-tab mirror, so the
 * wait scales with remote latency. Suppress the empty state for exactly that
 * wait — never on a clock, and never on mount-local state, which a reparent or
 * a reload would reset, stranding the pane with no way to open a terminal.
 */
export function shouldShowTabGroupEmptyState(args: {
  workspaceSessionReady: boolean
  tabCount: number
  awaitingFirstHostTabs: boolean
}): boolean {
  return args.workspaceSessionReady && args.tabCount === 0 && !args.awaitingFirstHostTabs
}

/** True only until the host publishes its first session-tab snapshot for this worktree. */
export function isAwaitingFirstHostTabs(
  runtimeEnvironmentId: string | null,
  worktreeId: string
): boolean {
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return false
  }
  // Why: a snapshot reporting zero tabs still publishes an epoch, so a remote workspace
  // genuinely resting at zero tabs reads as empty rather than perpetually pending.
  return getLatestWebSessionTabsPublicationEpoch(runtimeEnvironmentId, worktreeId) === null
}

export function useTabGroupEmptyStateVisible(worktreeId: string, tabCount: number): boolean {
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  // Why: the publication epoch lives in module-local maps, so a zero-tab snapshot moves no
  // store slice — without this subscription the pane would never re-ask and stay blank.
  const getAwaiting = useCallback(
    () => isAwaitingFirstHostTabs(runtimeEnvironmentId, worktreeId),
    [runtimeEnvironmentId, worktreeId]
  )
  const awaitingFirstHostTabs = useSyncExternalStore(
    subscribeWebSessionTabsPublication,
    getAwaiting,
    getAwaiting
  )
  return shouldShowTabGroupEmptyState({ workspaceSessionReady, tabCount, awaitingFirstHostTabs })
}
