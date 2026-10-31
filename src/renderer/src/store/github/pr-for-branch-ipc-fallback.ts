import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason
} from '../../../../shared/github/pull-request-refresh-types'

/** The direct lookup when main has no refresh coordinator; only a manual one may start a stopped WSL distro (E9). */
export function lookupPRForBranchOverIpc(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  options: { userRefresh?: boolean } = {}
): ReturnType<Window['api']['gh']['prForBranch']> {
  const fallbackPRNumber = candidate.fallbackPRNumber ?? null
  return window.api.gh.prForBranch({
    repoPath: candidate.repoPath,
    repoId: candidate.repoId || undefined,
    branch: candidate.branch,
    ...(options.userRefresh === true ? { userRefresh: true } : {}),
    linkedPRNumber: candidate.linkedPRNumber ?? null,
    fallbackPRNumber,
    acceptMergedFallbackPR:
      fallbackPRNumber !== null && (candidate.fallbackPRSource ?? null) !== null,
    currentHeadOid: candidate.currentHeadOid ?? null,
    ...(reason === 'manual' ? { wakeWslDistro: true } : {})
  })
}
