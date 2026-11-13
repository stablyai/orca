import type { AgentStatusObservation } from '../../agent-status/contracts/agent-status-observation'
import {
  isSameAgentProcess,
  type AgentProcessIdentity
} from '../../agent-status/process/agent-process-presence'

export type NativeChatPromptRootObservation = {
  observation: AgentStatusObservation
  process: AgentProcessIdentity
  sessionId?: string
  connectionId: string | null
}

export type NativeChatPromptSubmission = NativeChatPromptRootObservation & {
  sessionId: string
  textDigest: string
}

export type NativeChatPromptBinding = {
  runtimeId: string
  ptyId: string
  generation: number
  processIncarnation: string
  rootBaseline?: NativeChatPromptRootObservation
}

export type NativeChatSourceContext = {
  owner: string
  sessionId: string | null
  targetPtyId: string | null
  runtimeEnvironmentId: string | null
}

export type NativeChatPromptDispatch = NativeChatPromptBinding & {
  terminalHandle: string
  targetPtyId: string
  runtimeEnvironmentId: string | null
}

export function readNativeChatPromptDigest(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}

export function sameNativeChatPromptObservation(
  left: AgentStatusObservation | undefined,
  right: AgentStatusObservation | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.authorityId === right.authorityId &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision
  )
}

export function reuseNativeChatPromptSubmissions(
  previous: readonly NativeChatPromptSubmission[] | undefined,
  incoming: readonly NativeChatPromptSubmission[]
): readonly NativeChatPromptSubmission[] {
  if (!previous || previous === incoming || previous.length !== incoming.length) {
    return incoming
  }
  return incoming.every((entry, index) => {
    const before = previous[index]
    return (
      entry.sessionId === before.sessionId &&
      entry.connectionId === before.connectionId &&
      entry.textDigest === before.textDigest &&
      isSameAgentProcess(entry.process, before.process) &&
      sameNativeChatPromptObservation(entry.observation, before.observation) &&
      entry.observation.origin === before.observation.origin &&
      entry.observation.observedAt === before.observation.observedAt &&
      entry.observation.boundary === before.observation.boundary &&
      entry.observation.kind === before.observation.kind
    )
  })
    ? previous
    : incoming
}
