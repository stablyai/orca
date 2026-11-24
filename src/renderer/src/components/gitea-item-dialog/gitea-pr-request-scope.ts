import type { GiteaIssueScope } from '@/store/slices/gitea/gitea'

/** The repo selector plus call fields every repo-scoped Gitea call takes. */
export function scoped<T extends Record<string, unknown>>(
  scope: GiteaIssueScope,
  extra: T
): Required<Pick<GiteaIssueScope, 'repoPath'>> & Omit<GiteaIssueScope, 'repoPath'> & T {
  return {
    repoPath: scope.repoPath,
    repoId: scope.repoId ?? null,
    sourceContext: scope.sourceContext ?? null,
    ...(scope.repoOwnerExecutionHostId
      ? { repoOwnerExecutionHostId: scope.repoOwnerExecutionHostId }
      : {}),
    ...extra
  }
}
