import type { HostedReviewProvider } from './hosted-review'

export type HostedReviewCreationProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'

// Takes a plain string: the provider a client holds may be a token the host named and this build
// does not list, and answering "may I create with this?" for an unknown token is the whole job.
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
