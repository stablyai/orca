import type { HostedReviewProvider } from './hosted-review'

export type HostedReviewCreationProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'

export function supportsHostedReviewCreation(
  provider: HostedReviewProvider | null | undefined
): provider is HostedReviewCreationProvider {
  return (
    provider === 'github' ||
    provider === 'gitlab' ||
    provider === 'bitbucket' ||
    provider === 'azure-devops' ||
    provider === 'gitea'
  )
}

export function resolveHostedReviewCreationProvider(
  provider: HostedReviewProvider | null | undefined
): HostedReviewProvider {
  // Why: plugin forge providers pass their own id through — the main process
  // dispatches their ForgeProvider.createReview. Only absent providers fall
  // back to GitHub so creation UI stays enabled for unknown remotes.
  return supportsHostedReviewCreation(provider) ? provider : (provider ?? 'github')
}

// Why: plugin forge providers are handled in the main process via
// ForgeProvider.createReview, so the renderer never creates a review for one.
export function resolveCreationProvider(
  provider: HostedReviewProvider
): HostedReviewCreationProvider | null {
  return supportsHostedReviewCreation(provider) ? provider : null
}
