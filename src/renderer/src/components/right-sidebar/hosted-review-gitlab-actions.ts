import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { GitLabMRUpdate } from '../../../../shared/gitlab-types'
import {
  GITLAB_MR_APPROVAL_RUNTIME_CAPABILITY,
  GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'

type GitLabUpdateMRResult = Awaited<ReturnType<typeof window.api.gl.updateMR>>

export type GitLabApprovalChange = NonNullable<GitLabMRUpdate['approval']>

async function updateGitLabHostedReview(
  repo: Repo,
  mrNumber: number,
  updates: GitLabMRUpdate,
  capability: RuntimeCapability,
  updateRequiredMessage: string
): Promise<GitLabUpdateMRResult> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    await assertRuntimeEnvironmentCapability(host.environmentId, capability, updateRequiredMessage)
    return callRuntimeRpc<GitLabUpdateMRResult>(
      { kind: 'environment', environmentId: host.environmentId },
      'gitlab.updateMR',
      { repo: repo.id, iid: mrNumber, updates },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gl.updateMR({ repoPath: repo.path, repoId: repo.id, iid: mrNumber, updates })
}

export function markGitLabHostedReviewReadyForReview(args: {
  repo: Repo
  mrNumber: number
}): Promise<GitLabUpdateMRResult> {
  return updateGitLabHostedReview(
    args.repo,
    args.mrNumber,
    { readyForReview: true },
    GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
    GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE
  )
}

export function setGitLabHostedReviewApproval(args: {
  repo: Repo
  mrNumber: number
  approval: GitLabApprovalChange
}): Promise<GitLabUpdateMRResult> {
  return updateGitLabHostedReview(
    args.repo,
    args.mrNumber,
    { approval: args.approval },
    GITLAB_MR_APPROVAL_RUNTIME_CAPABILITY,
    GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE
  )
}
