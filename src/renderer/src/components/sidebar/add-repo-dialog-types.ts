import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type AddRepoDialogStep =
  | 'add'
  | 'clone'
  | 'remote'
  | 'server-path'
  | 'create'
  | 'nested'
  | 'space-conflict'

export type CompleteAddedGitRepo = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId,
  alreadyPresent?: boolean
) => Promise<void>

export function defaultProjectGroupNameForPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/g, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? path
  )
}

export function createNestedRepoScanId(): string {
  return `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
