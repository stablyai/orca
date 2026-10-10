import { normalizeSessionId } from './agent-session-resume'
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
  /** Provider session the owner holds now. */
  session?: string
  /** Sessions the owner held before (e.g. across Claude `/clear`), newest first. */
  heldSessions?: string[]
  ended?: true
}

export const MAX_OWNER_HELD_SESSIONS = 4

/** An agent session a producer runs inside, read from the env markers its parent exported. */
export type NestedAgentSession = { agent: AgentType; session: string }

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
  const session = 'session' in value ? normalizeSessionId(value.session) : null
  const heldSessions =
    'heldSessions' in value && Array.isArray(value.heldSessions)
      ? value.heldSessions
          .slice(0, MAX_OWNER_HELD_SESSIONS)
          .map(normalizeSessionId)
          .filter((held): held is string => held !== null)
      : []
  return {
    agent: value.agent,
    ...(process ? { process } : {}),
    ...(session ? { session } : {}),
    ...(heldSessions.length > 0 ? { heldSessions } : {}),
    ...('ended' in value && value.ended === true ? { ended: true as const } : {})
  }
}

export function isSameAgentProcess(a: AgentProcessIdentity, b: AgentProcessIdentity): boolean {
  return a.pid === b.pid && a.platform === b.platform && a.startTime === b.startTime
}
