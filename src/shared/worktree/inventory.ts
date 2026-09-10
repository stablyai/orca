import type { ExecutionHostId } from '../execution-host'
import type { DetectedWorktree } from './types'
import type { WorktreeLineage, WorkspaceLineage } from './lineage-types'

export type WorktreeInventoryRequest = {
  repo: string
  repoPath: string
  projectId: string
  hostId: ExecutionHostId
}

export type WorktreeInventoryRecord = {
  source:
    | 'legacy-metadata'
    | 'canonical-metadata'
    | 'identity-alias'
    | 'worktree-lineage'
    | 'workspace-lineage'
    | 'workspace-session'
  sourceKey: string
  worktreeId: string | null
  relatedWorktreeIds: string[]
  hostId: ExecutionHostId | null
  instanceId: string | null
  projectId: string | null
  projectHostSetupId: string | null
  partitionHostId?: ExecutionHostId
  lineage?: WorktreeLineage | WorkspaceLineage
  identityKeys: string[]
}

export type WorktreeInventoryRecords = {
  records: WorktreeInventoryRecord[]
  ambiguous: boolean
}

export type WorktreeInventoryFailureReason =
  | 'unsupported_host'
  | 'unsupported_workspace'
  | 'unsupported_runtime'
  | 'scope_mismatch'
  | 'scope_changed'
  | 'records_unavailable'
  | 'records_ambiguous'
  | 'records_changed'
  | 'scan_failed'

export type WorktreeInventoryResult = {
  scope: WorktreeInventoryRequest & { repoId: string | null; projectHostSetupId: string | null }
  source: 'git-and-orca-records'
  authoritative: boolean
  truncated: false
  totalCount: number
  failureReasons: WorktreeInventoryFailureReason[]
  worktrees: DetectedWorktree[]
  records: WorktreeInventoryRecord[]
}
