import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'

/** Topology and creation-time tab fields; presentation fields stay with the presenter. */
export type TerminalTopologyTabRow = Pick<
  TerminalTab,
  | 'id'
  | 'ptyId'
  | 'worktreeId'
  | 'launchAgent'
  | 'createdAt'
  | 'defaultTitle'
  | 'shellOverride'
  | 'startupCwd'
  | 'forceHostRuntime'
  | 'quickCommandLabel'
>

export type TerminalTopologyLayout = Pick<
  TerminalLayoutSnapshot,
  'root' | 'ptyIdsByLeafId' | 'titlesByLeafId'
>

/** One worktree's persisted terminal topology as main holds it, keyed by owning host partition. */
export type TerminalTopologySlice = {
  hostId: ExecutionHostId
  worktreeId: string
  /** Monotonic across every slice main publishes; a reader keeps the highest per worktree. */
  publishSeq: number
  revision: number
  tabs: TerminalTopologyTabRow[]
  layouts: Record<string, TerminalTopologyLayout>
  sleeping: Record<string, SleepingAgentSessionRecord>
}
