import { githubRepoIdentityKey } from '../../../../../shared/github/repositories/repository-identity-key'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../../shared/github/repositories/repository-identity'
import type { GitHubPRFile } from '../../../../../shared/github/pull-requests/pull-request-types'

/** Identifies one diff set: the PR revision plus the file shapes rendered for it. */
export function getPRFilesCombinedDiffSignature({
  files,
  repoId,
  prNumber,
  prRepo,
  headSha,
  baseSha
}: {
  files: GitHubPRFile[]
  repoId: string
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  headSha: string | undefined
  baseSha: string | undefined
}): string {
  return JSON.stringify({
    repoId,
    prNumber,
    prRepo: prRepo ? githubRepoIdentityKey(prRepo) : null,
    headSha: headSha ?? null,
    baseSha: baseSha ?? null,
    files: files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isBinary: file.isBinary
    }))
  })
}
