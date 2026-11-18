import { supportsHostedReviewCreation } from '../../../../../../shared/source-control/hosted-review/hosted-review-creation-providers'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'

export function resolveProvisionalHostedReviewProvider(input: {
  hostedReview?: Pick<HostedReviewInfo, 'provider'> | null
  hostedReviewCreationState?: {
    repoId: string
    data: Pick<HostedReviewCreationEligibility, 'provider'>
  } | null
  activeRepoId?: string | null
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  // Infer the remote provider before defaulting to GitHub so loading/failed probes retain provider-specific copy.
  remoteInferredProvider?: HostedReviewProvider | null
}): HostedReviewProvider {
  if (input.hostedReview?.provider && supportsHostedReviewCreation(input.hostedReview.provider)) {
    return input.hostedReview.provider
  }
  if (
    input.hostedReviewCreationState &&
    input.activeRepoId === input.hostedReviewCreationState.repoId &&
    supportsHostedReviewCreation(input.hostedReviewCreationState.data.provider)
  ) {
    return input.hostedReviewCreationState.data.provider
  }
  if (input.linkedGitLabMR != null) {
    return 'gitlab'
  }
  if (input.linkedAzureDevOpsPR != null) {
    return 'azure-devops'
  }
  if (input.linkedGiteaPR != null) {
    return 'gitea'
  }
  if (input.linkedGitHubPR != null || input.fallbackGitHubPR != null) {
    return 'github'
  }
  if (input.remoteInferredProvider && supportsHostedReviewCreation(input.remoteInferredProvider)) {
    return input.remoteInferredProvider
  }
  return 'github'
}
