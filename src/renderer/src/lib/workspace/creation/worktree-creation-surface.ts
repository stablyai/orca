import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import type { UISlice } from '@/store/slices/ui/ui-slice-contract'
import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import {
  pendingWorktreeCreationIsVisible,
  type WorktreeCreationRequest,
  type PendingWorktreeCreation
} from '@/lib/workspace/creation/pending-worktree-creation'

export function isInstantFolderWorktreeCreation(
  state: Pick<AppState, 'repos'>,
  request: WorktreeCreationRequest
): boolean {
  const hostId = request.workspaceRunContext?.hostId ?? request.executionHostId
  const repos = getIndexedReposById(state.repos, request.repoId).filter(
    (repo) => !hostId || getRepoExecutionHostId(repo) === hostId
  )
  return (
    request.worktreeCreateProgressMode === 'stepped' &&
    repos.length === 1 &&
    isFolderRepo(repos[0]) &&
    request.agentLaunchRoute !== 'structured-native-chat' &&
    !request.ephemeralVmRecipe &&
    !request.ephemeralVmRuntimeId &&
    !request.ephemeralVmRuntimeEnvironmentId
  )
}

export type WorktreeCreationSurfaceInput = {
  activeView: UISlice['activeView']
  activePendingCreationId: string | null
  hasActivePendingCreation: boolean
}

export function isWorktreeCreationSelected(
  state: Pick<UISlice, 'activeView'> & {
    activePendingCreationId: string | null
    pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  },
  creationId: string,
  originView: UISlice['activeView']
): boolean {
  return (
    state.activePendingCreationId === creationId &&
    (state.activeView === originView ||
      (state.activeView === 'terminal' &&
        state.pendingWorktreeCreations[creationId]?.loaderVisible === true))
  )
}

export function shouldShowWorktreeCreationSurface({
  activeView,
  activePendingCreationId,
  hasActivePendingCreation
}: WorktreeCreationSurfaceInput): boolean {
  return activeView === 'terminal' && activePendingCreationId !== null && hasActivePendingCreation
}

export function selectWorktreeCreationSurfaceShown(
  state: Pick<AppState, 'activeView' | 'activePendingCreationId' | 'pendingWorktreeCreations'>
): boolean {
  const { activeView, activePendingCreationId } = state
  return shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation:
      activePendingCreationId !== null &&
      pendingWorktreeCreationIsVisible(state.pendingWorktreeCreations[activePendingCreationId])
  })
}

// Why: the created row is listed before completion, so a user may already have opened it.
export function isCreatedWorkspaceInView(
  state: Parameters<typeof isWorktreeCreationSelected>[0] & { activeWorktreeId: string | null },
  creationId: string,
  worktreeId: string,
  originView: UISlice['activeView']
): boolean {
  return (
    isWorktreeCreationSelected(state, creationId, originView) ||
    (state.activeView === 'terminal' &&
      state.activePendingCreationId === null &&
      state.activeWorktreeId === worktreeId)
  )
}

export function showWorktreeCreationError(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activePendingCreationId'
    | 'pendingWorktreeCreations'
    | 'setActiveView'
    | 'setActivePendingWorktreeCreation'
    | 'updatePendingWorktreeCreation'
  >,
  creationId: string,
  originView: UISlice['activeView'],
  message: string,
  request?: WorktreeCreationRequest
): void {
  const selected = isWorktreeCreationSelected(state, creationId, originView)
  if (!selected && state.activePendingCreationId === creationId) {
    state.setActivePendingWorktreeCreation(null)
  }
  state.updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: message,
    ...(request ? { request } : {})
  })
  if (selected) {
    state.setActiveView('terminal')
  } else {
    toast.error(message)
  }
}
