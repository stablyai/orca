import { useAppStore } from '@/store'
import { queueSetupAndIssueCommands } from './worktree-setup-issue-command-queue'
import { gateWorkspaceWithoutReseed } from './worktree-activation-gated-empty-reseed'
import type { WorktreeActivationOptions } from './worktree-activation-surface-selection'

export function activateOwnedWorktreeNavigation(
  worktreeId: string,
  opts: WorktreeActivationOptions | undefined
): boolean {
  const ownedNavigation =
    opts?.creationOwnsFirstSurface === true &&
    !opts.startup &&
    !opts.defaultTabs &&
    !opts.issueCommand
  if (ownedNavigation) {
    if (opts?.setup) {
      // Setup always opens in its own tab, so it needs no terminal to anchor to.
      const current = useAppStore.getState()
      queueSetupAndIssueCommands(
        current,
        worktreeId,
        current.tabsByWorktree[worktreeId]?.[0]?.id ?? null,
        opts.setup,
        undefined,
        undefined,
        undefined
      )
    }
    void gateWorkspaceWithoutReseed(worktreeId)
  }

  return ownedNavigation
}
