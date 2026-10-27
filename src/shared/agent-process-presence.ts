import { AGENT_TYPE_MAX_LENGTH } from './agent-status-field-normalization'
import type { AgentType } from './agent-status-types'

export type AgentProcessIdentity = {
  pid: number
  platform: 'darwin' | 'linux' | 'win32'
  startTime: string
}

/** The agent that owns a pane, from its first hook until it ends; the process when a hook proved it. */
export type AgentProcessPresence = {
  agent: AgentType
  process?: AgentProcessIdentity
  /** Provider session that claimed the pane; later turns of the owner reuse it. */
  session?: string
  ended?: true
  /** This host verifies process ownership before accepting a different provider. */
  sessionOwner?: true
  /** Positive host observation of suspension, distinct from an unavailable process read. */
  suspended?: true
}

export type AgentProcessVerdict = 'live' | 'unverifiable' | 'exited'

export function readAgentProcessIdentity(value: unknown): AgentProcessIdentity | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  if (!('pid' in value) || !('platform' in value) || !('startTime' in value)) {
    return undefined
  }
  const { pid, platform, startTime } = value
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid > 0xffffffff ||
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    typeof startTime !== 'string' ||
    startTime.length === 0 ||
    startTime.length > 160
  ) {
    return undefined
  }
  return { pid, platform, startTime }
}

// Why: only Claude's hook command captures its agent's process; other hooks cannot speak for liveness.
export function readHookAgentProcess(
  source: string,
  value: unknown
): AgentProcessIdentity | undefined {
  return source === 'claude' ? readAgentProcessIdentity(value) : undefined
}

export function readAgentProcessPresence(value: unknown): AgentProcessPresence | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('agent' in value) ||
    typeof value.agent !== 'string' ||
    !value.agent ||
    value.agent.length > AGENT_TYPE_MAX_LENGTH
  ) {
    return undefined
  }
  const process = 'process' in value ? readAgentProcessIdentity(value.process) : undefined
  const session =
    'session' in value && typeof value.session === 'string' && value.session.length <= 256
      ? value.session
      : undefined
  return {
    agent: value.agent,
    ...(process ? { process } : {}),
    ...(session ? { session } : {}),
    ...('ended' in value && value.ended === true ? { ended: true as const } : {}),
    ...('sessionOwner' in value && value.sessionOwner === true
      ? { sessionOwner: true as const }
      : {}),
    ...('suspended' in value && value.suspended === true ? { suspended: true as const } : {})
  }
}

export function isSameAgentProcess(a: AgentProcessIdentity, b: AgentProcessIdentity): boolean {
  return a.pid === b.pid && a.platform === b.platform && a.startTime === b.startTime
}

/** A hook without a process identity can only be told apart from the owner by its provider. */
export function hasOtherAgentProcessOwner(
  presence: AgentProcessPresence | undefined,
  incoming: { agent: string; process?: AgentProcessIdentity }
): boolean {
  return Boolean(
    presence?.process &&
    presence.sessionOwner &&
    !presence.ended &&
    !presence.suspended &&
    presence.agent !== 'unknown' &&
    (presence.agent !== incoming.agent ||
      (incoming.process && !isSameAgentProcess(presence.process, incoming.process)))
  )
}
