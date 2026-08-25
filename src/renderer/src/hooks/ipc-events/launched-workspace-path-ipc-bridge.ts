import { useAppStore } from '../../store'
import { isGitRepoKind } from '../../../../shared/repo-kind'

/** Fetches a freshly added git repo's worktrees and activates its main (or first) one. */
async function revealAddedRepo(repoId: string): Promise<void> {
  await useAppStore.getState().fetchWorktrees(repoId)
  const worktrees = useAppStore.getState().worktreesByRepo[repoId] ?? []
  const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0]
  if (!mainWorktree) {
    return
  }
  // Why: lazy import mirrors repo-add-actions to avoid a circular module load through the store root.
  const { activateAndRevealWorktree } = await import('@/lib/worktree-activation')
  activateAndRevealWorktree(mainWorktree.id, { sidebarRevealBehavior: 'auto' })
}

/**
 * Adds each launched folder as a project through the existing add-project
 * pipeline and reveals its workspace; one failing path never blocks the rest.
 */
export async function openLaunchedWorkspacePaths(folderPaths: readonly string[]): Promise<void> {
  for (const folderPath of folderPaths) {
    try {
      const repo = await useAppStore.getState().addRepoPath(folderPath, 'git')
      if (repo && isGitRepoKind(repo)) {
        await revealAddedRepo(repo.id)
      }
    } catch (error) {
      console.error('Failed to open launched folder as a project:', error)
    }
  }
}

/**
 * Subscribes to pushed launch intents, then tells main this renderer can
 * receive them so queued intents flush immediately instead of waiting for a
 * remount that may never come.
 */
export function registerLaunchedWorkspacePathIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenWorkspacePath?.((folderPath) => {
      void openLaunchedWorkspacePaths([folderPath])
    }) ?? (() => {})
  )
  window.api.ui.notifyWorkspacePathBridgeReady?.()
}
