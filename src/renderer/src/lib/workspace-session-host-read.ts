import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'

import type { HostSessionSlices } from './workspace-session-host-split'

export type WorkspaceSessionHostRead = {
  session: WorkspaceSessionState
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  contestedHostWorkspaceSessions: HostSessionSlices
  contestedPrimaryHostBySessionKey: Record<string, ExecutionHostId>
  /** Read partitions; a parked shadow still prevents whole-field clears. */
  hydratedRuntimeSessionHostIds: ExecutionHostId[]
}
