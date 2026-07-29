import type { ExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { SshExecutionHostId } from './detected-worktree-provider-contract'
import type { DirectSshAuthority } from './ssh-types'
import type { WorktreeLineage, WorkspaceLineage } from './types'

export type ListDesktopLineageForHostArgs =
  | { executionHostId: typeof LOCAL_EXECUTION_HOST_ID }
  | {
      executionHostId: SshExecutionHostId
      expectedAuthority: DirectSshAuthority
    }

export type HostLineageSnapshot =
  | {
      authoritative: true
      authority:
        | { kind: 'local'; executionHostId: typeof LOCAL_EXECUTION_HOST_ID }
        | ({
            kind: 'direct-ssh'
            executionHostId: SshExecutionHostId
          } & DirectSshAuthority)
      worktreeLineageById: Record<string, WorktreeLineage>
      workspaceLineageByChildKey: Record<string, WorkspaceLineage>
    }
  | {
      authoritative: false
      executionHostId: ExecutionHostId
      reason: 'ambiguous-owner' | 'authority-unknown' | 'stale' | 'unavailable' | 'rejected'
    }
