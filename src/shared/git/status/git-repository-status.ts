import type { GitStatusResult } from './git-status-types'

export const GIT_REPOSITORY_STATUS_CAPABILITY = 'git.repository-status.v1' as const
export const GIT_REPOSITORY_PROBE_BATCH_SIZE = 100
export const GIT_REPOSITORY_IGNORE_BATCH_SIZE = 2000

export type GitRepositoryStatusRequest = {
  repositoryPaths?: string[]
  repositoryIntent?: 'probe' | 'status' | 'ignored'
  repositoryQueryPaths?: string[]
}

export type GitRepositoryStatus = {
  path: string
  kind: 'repository' | 'absent' | 'unknown'
  status?: GitStatusResult
  ignoredPaths?: string[]
}
