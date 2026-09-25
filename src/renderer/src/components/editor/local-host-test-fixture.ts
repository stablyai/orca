import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

/** Stands in for the host-connection module in suites that mock the store: every worktree is local. */
const LOCAL_HOST_CONNECTION: WorktreeHostConnection = {
  phase: 'local',
  targetId: null,
  environmentId: null,
  status: null,
  connectedEpoch: null
}

export function selectWorktreeHostConnectionPhase(): WorktreeHostConnection {
  return LOCAL_HOST_CONNECTION
}

export function useWorktreeHostConnection(): WorktreeHostConnection {
  return LOCAL_HOST_CONNECTION
}
