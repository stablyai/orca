import { z } from 'zod'
import type { ExecutionHostHealth } from './execution-host-health'

// Why: both are answered by the paired desktop itself; the phone lists servers the desktop shows.
export const MOBILE_RELAY_HOSTS_LIST_METHOD = 'mobileRelay.hosts.list'
export const MOBILE_RELAY_HOST_WORKTREES_METHOD = 'mobileRelay.hosts.worktrees'
// Why the desktop's: its renderer alone sleeps a server's workspace and holds its slept agents.
export const MOBILE_RELAY_HOST_SLEEP_WORKTREE_METHOD = 'mobileRelay.hosts.sleepWorktree'
export const MOBILE_RELAY_HOST_WAKE_SLEEPING_AGENTS_METHOD = 'mobileRelay.hosts.wakeSleepingAgents'

/** Whether the desktop can relay the phone to this server now; `update-needed` is the server's build. */
export type MobileRelayHostRelay = 'ready' | 'update-needed' | 'unavailable'

export type MobileRelayHost = {
  hostId: `runtime:${string}`
  label: string
  health: ExecutionHostHealth
  relay: MobileRelayHostRelay
}

export type MobileRelayHostsListResult = { hosts: MobileRelayHost[] }

export const MobileRelayHostWorktreesParamsSchema = z
  .object({ hostId: z.string().min(1).max(1024) })
  .strict()

/** A server's workspace, by the server's host id and its own worktree id. */
export const MobileRelayHostWorktreeParamsSchema = z
  .object({
    hostId: z.string().startsWith('runtime:').max(1024),
    worktreeId: z.string().min(1).max(4096)
  })
  .strict()

/** One of a server's own `worktree.ps` rows (RuntimeWorktreePsSummary), carrying the server's host id. */
export type MobileRelayServerWorktreeRow = Record<string, unknown> & { hostId: `runtime:${string}` }

/**
 * The server's own `worktree.ps` rows as the desktop last fetched them. `stale` means this call
 * could not refresh them; rows are never rewritten beyond their host id.
 */
export type MobileRelayHostWorktreesResult =
  | {
      worktrees: MobileRelayServerWorktreeRow[]
      totalCount: number
      truncated: boolean
      fetchedAt: number
      stale: boolean
    }
  | { worktrees: null }
