import type { GitHubOwnerRepo } from '../../../../shared/types'

function normalizedPRRepoIdentity(prRepo?: GitHubOwnerRepo | null): string {
  if (!prRepo) {
    return 'none'
  }
  return `${prRepo.owner.toLowerCase()}/${prRepo.repo.toLowerCase()}`
}

export function checksPanelAsyncResultKey(
  repoId: string,
  branch: string,
  prNumber: number | null,
  prRepo?: GitHubOwnerRepo | null,
  headSha?: string | null
): string {
  return `${repoId}::${branch}::${normalizedPRRepoIdentity(prRepo)}::${prNumber ?? 'none'}::${
    headSha ?? 'none'
  }`
}

export function shouldCommitChecksPanelAsyncResult(
  currentKey: string,
  requestKey: string
): boolean {
  return currentKey === requestKey
}
