import type { HostedReviewProvider } from './hosted-review'

export type HostedReviewCreationProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'

// Accept arbitrary wire strings so newer hosts’ unknown provider tokens fail the creation gate safely.
export function supportsHostedReviewCreation(
  provider: string | null | undefined
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
): HostedReviewCreationProvider {
  return supportsHostedReviewCreation(provider) ? provider : 'github'
}
