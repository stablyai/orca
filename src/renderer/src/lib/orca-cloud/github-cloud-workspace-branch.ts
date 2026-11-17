// A GitHub-only Orca Cloud create clones the repository on its default branch. Like an owned
// create, the workspace is then its own branch off that, so its agents never commit to (or push)
// the default branch, and its row shows the workspace's name rather than "master".
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

/** The new workspace's id, or null when the branch couldn't be made (the caller says so). */
export async function createGitHubCloudWorkspaceBranch(args: {
  /** The sandbox's clone, on the default branch. */
  primaryWorktreeId: string
  name: string
  hostId: ExecutionHostId | undefined
  sandboxId?: string
}): Promise<string | null> {
  const store = useAppStore.getState()
  const primary = findWorktreeById(store, args.primaryWorktreeId, args.hostId)
  if (!primary) {
    return null
  }
  try {
    const { worktree } = await store.createWorktree(
      primary.repoId,
      args.name,
      undefined,
      'inherit',
      undefined,
      'unknown',
      args.name,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      args.hostId ? { executionHostId: args.hostId } : undefined
    )
    if (args.sandboxId) {
      // Other devices open the workspace's own worktree, not the clone.
      const branch = worktree.branch.replace(/^refs\/heads\//, '')
      void window.api.cloudWorkspaces.patch(args.sandboxId, { branch }).catch(() => undefined)
    }
    return worktree.id
  } catch (error) {
    console.warn('[orca-cloud] GitHub create: workspace branch failed', error)
    return null
  }
}
