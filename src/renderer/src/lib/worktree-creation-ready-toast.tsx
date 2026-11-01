import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { workspaceNavigationToastAction } from '@/lib/workspace-navigation-toast-action'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { resolveIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { Worktree } from '../../../shared/worktree/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/** Announces a create that finished after the user left its creation surface, instead of pulling them to it. */
export function showWorktreeCreationReadyToast(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'branch' | 'path' | 'hostId'>,
  creationHostId?: ExecutionHostId
): void {
  const owner = resolveIndexedWorktreeOwner(
    selectWorktreesByRepo(useAppStore.getState()),
    worktree.id
  )
  const ownerHostId = creationHostId ?? (owner.kind === 'resolved' ? owner.owner.hostId : undefined)
  // Paired create responses name the server's host; use the renderer's ownership projection.
  const executionHostId =
    owner.kind === 'ambiguous' && creationHostId === undefined
      ? null
      : ownerHostId
        ? (withRepoHostOwnership(worktree, ownerHostId).hostId ?? ownerHostId)
        : worktree.hostId
  const isViewingWorktree = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    state.activeView === 'terminal' &&
    state.activePendingCreationId === null &&
    state.activeWorktreeId !== null &&
    worktreeIdsEqual(state.activeWorktreeId, worktree.id) &&
    executionHostId !== null &&
    (executionHostId === undefined ||
      // Owner rows only: the Active Server setting never says which host's workspace is open.
      (state.activeWorkspaceExecutionHostId ??
        getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)) === executionHostId)
  if (isViewingWorktree(useAppStore.getState())) {
    return
  }

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
  let retired = false
  const retire = (): void => {
    retired = true
    unsubscribe()
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (isViewingWorktree(state)) {
      // Navigation can change the view before replacing the remembered workspace.
      queueMicrotask(() => {
        if (!retired && isViewingWorktree(useAppStore.getState())) {
          retire()
          toast.dismiss(toastId)
        }
      })
    }
  })
  const toastId = toast.success(title, {
    // Keep the way back until the user opens the workspace or dismisses the toast.
    duration: Infinity,
    onDismiss: retire,
    onAutoClose: retire,
    action: workspaceNavigationToastAction({
      workspaceId: worktree.id,
      executionHostId: executionHostId ?? undefined,
      isFolder,
      onNavigate: retire
    })
  })
}
