import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

export function getComposerCloneSource(props: NewWorkspaceComposerCardProps) {
  const selectedRepo =
    props.selectedRepo ??
    props.eligibleRepos.find(
      (candidate) =>
        candidate.id === props.repoId &&
        (!props.selectedRepoExecutionHostId ||
          getRepoExecutionHostId(candidate) === props.selectedRepoExecutionHostId) &&
        (!props.selectedRepoPath || candidate.path === props.selectedRepoPath)
    )
  const cloneSource = selectedRepo
    ? {
        repoId: selectedRepo.id,
        hostId: getRepoExecutionHostId(selectedRepo),
        path: selectedRepo.path
      }
    : props.selectedRepoExecutionHostId && props.repoId
      ? {
          repoId: props.repoId,
          hostId: props.selectedRepoExecutionHostId,
          path: props.selectedRepoPath
        }
      : undefined
  const cloneSourceKey = JSON.stringify([
    props.selectedProjectId ?? null,
    cloneSource?.repoId,
    cloneSource?.hostId,
    props.selectedRepoPath
  ])
  return { selectedRepo, cloneSource, cloneSourceKey }
}
