import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Worktree } from '../../../shared/worktree/types'

/** Announces a create that finished after the user left its creation surface, instead of pulling them to it. */
export function showWorktreeCreationReadyToast(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'branch' | 'path'>
): void {
  const name = resolveWorktreeDisplayName(worktree)
  const repo = getIndexedRepoMap(useAppStore.getState().repos).get(worktree.repoId)
  // Why: a folder repo's workspace is not a git worktree, so its title and button say workspace.
  const isFolder = repo !== undefined && isFolderRepo(repo)
  const title = isFolder
    ? translate(
        'components.workspace.creation.workspaceReadyToast',
        'Workspace {{name}} is ready',
        {
          name
        }
      )
    : translate('components.workspace.creation.worktreeReadyToast', 'Worktree {{name}} is ready', {
        name
      })
  const goToLabel = isFolder
    ? translate('components.workspace.creation.goToWorkspace', 'Go to workspace')
    : translate('components.workspace.creation.goToWorktree', 'Go to worktree')
  toast.success(title, {
    action: {
      label: (
        <span className="inline-flex items-center gap-1.5">
          <ExternalLink className="size-3" />
          {goToLabel}
        </span>
      ),
      onClick: () => {
        activateAndRevealWorktree(worktree.id, {
          sidebarRevealBehavior: 'auto',
          navigationIntent: 'user-open'
        })
      }
    }
  })
}
