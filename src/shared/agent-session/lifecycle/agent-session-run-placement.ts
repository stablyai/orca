import {
  isAgentSessionProcessIdentity,
  type AgentSessionProcessIdentity
} from './agent-session-record'

/** Which terminal-host daemon start holds a relayed run, pid-reuse-safe. */
export type AgentSessionRunDaemon = {
  /** Random per daemon start: its hello `launchNonce`. */
  instance: string
  pid: number
  startedAtMs: number
}

/**
 * Where the run at `fence` started: in this app (it ends with the app), or under one daemon start
 * (only that daemon says whether it still runs). Owner release never clears it; only the next run's
 * process commit replaces it.
 */
export type AgentSessionRunPlacement =
  | { fence: number; kind: 'direct' }
  | {
      fence: number
      kind: 'relayed'
      relayId: string
      daemon: AgentSessionRunDaemon
      /** The run's agent process, kept here because owner release clears the lease's copy. */
      agent: AgentSessionProcessIdentity
    }

/** What a launch knows before the process commit adds the fence and the agent's identity. */
export type AgentSessionRunPlacementLaunch =
  | { kind: 'direct' }
  | { kind: 'relayed'; relayId: string; daemon: AgentSessionRunDaemon }

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const shortString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256

function runDaemon(value: unknown): value is AgentSessionRunDaemon {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each field is checked below.
  const daemon = value as Partial<AgentSessionRunDaemon>
  return (
    shortString(daemon.instance) &&
    positiveInt(daemon.pid) &&
    typeof daemon.startedAtMs === 'number' &&
    Number.isFinite(daemon.startedAtMs)
  )
}

/**
 * The record's last run placement, or null when absent or malformed (read as a run that ended with
 * its app). A bad placement never makes the whole record unreadable.
 */
export function agentSessionRunPlacement(record: {
  lastRunPlacement?: unknown
}): AgentSessionRunPlacement | null {
  const value = record.lastRunPlacement
  if (typeof value !== 'object' || value === null) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each field is checked below.
  const placement = value as Record<string, unknown>
  const fence = placement.fence
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence)) {
    return null
  }
  if (placement.kind === 'direct') {
    return { fence, kind: 'direct' }
  }
  return placement.kind === 'relayed' &&
    shortString(placement.relayId) &&
    runDaemon(placement.daemon) &&
    isAgentSessionProcessIdentity(placement.agent)
    ? {
        fence,
        kind: 'relayed',
        relayId: placement.relayId,
        daemon: placement.daemon,
        agent: placement.agent
      }
    : null
}
