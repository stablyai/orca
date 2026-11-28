import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'

export type ForcedVisibleSidebarRows = {
  forcedVisibleWorktreeIds?: readonly string[]
  forcedVisibleWorktreeIdentities?: readonly string[]
}

function selectActiveWorktreeIdentity(state: AppState): string | null {
  const id = getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
  const worktree = id
    ? state.getKnownWorktreeById(id, state.activeWorkspaceExecutionHostId ?? undefined)
    : undefined
  return worktree ? composeWorktreeHostIdentity(worktree.hostId, worktree.id) : null
}

/** Rows listed despite the filters: the agent send target, and the active workspace while it stays active. */
export function useForcedVisibleSidebarRows(
  agentSendTargetWorktreeId: string | null
): ForcedVisibleSidebarRows {
  const activeIdentity = useAppStore(selectActiveWorktreeIdentity)
  return useMemo(
    () => ({
      forcedVisibleWorktreeIds: agentSendTargetWorktreeId ? [agentSendTargetWorktreeId] : undefined,
      forcedVisibleWorktreeIdentities: activeIdentity ? [activeIdentity] : undefined
    }),
    [agentSendTargetWorktreeId, activeIdentity]
  )
}
