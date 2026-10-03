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
  ended?: true
  /** Relay ordering survives replay and owner-only retention without renewing evidence. */
  observation?: AgentPresenceObservation
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
  const observation =
    'observation' in value ? readAgentPresenceObservation(value.observation) : undefined
  const process = 'process' in value ? readAgentProcessIdentity(value.process) : undefined
  return {
    agent: value.agent,
    ...(observation ? { observation } : {}),
    ...(process ? { process } : {}),
    ...('ended' in value && value.ended === true ? { ended: true as const } : {})
  }
}

export function isSameAgentProcess(a: AgentProcessIdentity, b: AgentProcessIdentity): boolean {
  return a.pid === b.pid && a.platform === b.platform && a.startTime === b.startTime
}

export type AgentPresenceObservation = { epoch: string; sequence: number }

export function readAgentPresenceObservation(value: unknown): AgentPresenceObservation | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('epoch' in value) ||
    !('sequence' in value) ||
    typeof value.epoch !== 'string' ||
    value.epoch.length === 0 ||
    value.epoch.length > 128 ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1
  ) {
    return undefined
  }
  return { epoch: value.epoch, sequence: value.sequence }
}
