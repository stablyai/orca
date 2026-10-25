import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import {
  canUseWorkspaceReviewForChecks,
  isWorkspaceRepositoryAttachment
} from './worktree-attachment-editing'
import type { WorkspaceReferenceRequest } from './workspace-reference-details'

export function canReadWorkspaceReferenceReview(
  request: WorkspaceReferenceRequest,
  knownProvider?: HostedReviewProvider
): boolean {
  const { item, sourceContext, repo } = request
  if (!repo || !canUseWorkspaceReviewForChecks(item, repo, knownProvider)) {
    return false
  }
  if (
    sourceContext &&
    (sourceContext.hostId !== getRepoExecutionHostId(repo) ||
      (sourceContext.repoId && sourceContext.repoId !== repo.id) ||
      (sourceContext.accountLabel &&
        (item.provider !== 'github' || sourceContext.accountLabel !== repo.ghAccount?.user)))
  ) {
    return false
  }
  const identity = sourceContext?.providerIdentity
  const identityUrl =
    identity?.provider === 'github'
      ? `https://${identity.host ?? 'github.com'}/${identity.owner}/${identity.repo}/pull/${item.number}`
      : identity?.provider === 'gitlab' && identity.webUrl
        ? `${identity.webUrl}/-/merge_requests/${item.number}`
        : null
  return !identityUrl || isWorkspaceRepositoryAttachment({ ...item, url: identityUrl }, repo)
}
