import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { resolveRepoForWorktreeTarget } from './worktree-delete-repo-resolve'

/** Open confirm-remove for a primary worktree, or refuse when the host is ambiguous. */
export function openMainWorktreeProjectRemove(
  target: Pick<Worktree, 'repoId' | 'hostId' | 'displayName'>
): void {
  const state = useAppStore.getState()
  const repo = resolveRepoForWorktreeTarget(state.repos, target)
  const hostId = target.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  // Why: without a host pin, confirm can remove a twin on the focused host (#13071/#13536).
  if (!hostId) {
    toast.error(
      translate(
        'auto.components.sidebar.delete.worktree.flow.ambiguousProjectHost',
        'Could not determine which host owns this project. Select it from the sidebar and try again.'
      )
    )
    return
  }
  // Why: git refuses to delete the primary checkout; users can still remove the project from Orca.
  state.openModal('confirm-remove-folder', {
    repoId: target.repoId,
    displayName: repo?.displayName ?? target.displayName,
    hostId
  })
}
