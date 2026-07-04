import type { GiteaIssueScope } from '@/store/slices/gitea'

// Builds the common { repoPath, repoId, sourceContext, ...extra } payload that
// the Gitea PR IPC calls expect from a task-source scope.
export function scoped<T extends Record<string, unknown>>(
  scope: GiteaIssueScope,
  extra: T
): {
  repoPath: string
  repoId: string | null
  sourceContext: GiteaIssueScope['sourceContext']
} & T {
  return {
    repoPath: scope.repoPath,
    repoId: scope.repoId ?? null,
    sourceContext: scope.sourceContext ?? null,
    ...extra
  }
}
