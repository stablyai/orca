import type { HostedReviewProvider } from './hosted-review'

export type HostedReviewCreationProvider = 'github' | 'gitlab' | 'azure-devops' | 'gitea'

export function supportsHostedReviewCreation(
  provider: HostedReviewProvider | null | undefined
): provider is HostedReviewCreationProvider {
  return (
    provider === 'github' ||
    provider === 'gitlab' ||
    provider === 'azure-devops' ||
    provider === 'gitea'
  )
}

export function resolveHostedReviewCreationProvider(
  provider: HostedReviewProvider | null | undefined
): HostedReviewCreationProvider {
  return supportsHostedReviewCreation(provider) ? provider : 'github'
}
