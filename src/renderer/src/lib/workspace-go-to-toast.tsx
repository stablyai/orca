import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Worktree } from '../../../shared/worktree/types'

export type WorkspaceGoToToastTarget = Pick<
  Worktree,
  'id' | 'repoId' | 'displayName' | 'branch' | 'path'
>

/**
 * Announces work that finished in a workspace the user left, with a button that takes them there,
 * instead of pulling them to it.
 */
export function showWorkspaceGoToToast(
  worktree: WorkspaceGoToToastTarget,
  args: {
    title: (target: { name: string; isFolder: boolean }) => string
    /** Runs once the workspace is open, e.g. to focus the tab the work landed in. */
    afterOpen?: () => void
  }
): void {
  const name = resolveWorktreeDisplayName(worktree)
  const repo = getIndexedRepoMap(useAppStore.getState().repos).get(worktree.repoId)
  // Why: a folder repo's workspace is not a git worktree, so its title and button say workspace.
  const isFolder = repo !== undefined && isFolderRepo(repo)
  const goToLabel = isFolder
    ? translate('components.workspace.creation.goToWorkspace', 'Go to workspace')
    : translate('components.workspace.creation.goToWorktree', 'Go to worktree')
  toast.success(args.title({ name, isFolder }), {
    action: {
      label: (
        <span className="inline-flex items-center gap-1.5">
          <ExternalLink className="size-3" />
          {goToLabel}
        </span>
      ),
      onClick: () => {
        const opened = activateAndRevealWorktree(worktree.id, {
          sidebarRevealBehavior: 'auto',
          navigationIntent: 'user-open'
        })
        if (opened !== false) {
          args.afterOpen?.()
        }
      }
    }
  })
}
