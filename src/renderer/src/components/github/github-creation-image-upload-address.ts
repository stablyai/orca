import { hostedReviewRepoOwnerTarget } from '@/store/slices/hosted-review/hosted-review-cache-state'
import type { GitHubImageIntake } from './use-github-image-uploads'

export function githubCreationImageUploadAddress(
  repo:
    | (NonNullable<Parameters<typeof hostedReviewRepoOwnerTarget>[0]> & { id: string })
    | null
    | undefined,
  worktreePath: string | null | undefined,
  provider: string,
  onPending: (pending: boolean) => void
): GitHubImageIntake | undefined {
  if (provider !== 'github') {
    return undefined
  }
  return {
    onPending,
    address: () => {
      if (!repo) {
        throw new Error('Open this repository before attaching an image.')
      }
      return {
        runtime: hostedReviewRepoOwnerTarget(repo),
        target: {
          kind: 'repo',
          repo: repo.id,
          source: 'origin',
          ...(worktreePath ? { worktree: `path:${worktreePath}` } : {})
        }
      }
    }
  }
}
