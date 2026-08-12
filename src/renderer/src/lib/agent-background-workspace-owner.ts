import type { useAppStore } from '@/store'
import { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import { resolveAgentSessionWorkspaceOwner } from '@/lib/agent-session-workspace-owner'

type StoreState = ReturnType<typeof useAppStore.getState>

export function resolveAgentBackgroundWorkspaceOwner(store: StoreState, worktreeId: string) {
  const owner = resolveAgentSessionWorkspaceOwner(store, worktreeId)
  return {
    ...owner,
    // Folder launch ownership cannot be derived from a repo row (#2989).
    launchHost: resolveAgentBackgroundLaunchHost({
      store,
      worktreeId,
      worktreePath: owner.worktree.path,
      repo: owner.repo
    })
  }
}
