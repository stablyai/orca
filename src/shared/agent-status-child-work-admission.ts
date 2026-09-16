import type { AgentChildWorkAliasKind } from './agent-status-child-work-alias'
import type {
  AgentChildWorkId,
  AgentChildWorkInvocationFence,
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkOutcome,
  AgentChildWorkProviderTiming,
  AgentChildWorkProvenance,
  AgentChildWorkRecord,
  AgentChildWorkState
} from './agent-status-child-work'
import {
  adoptAgentChildWork,
  announceAgentChildWork,
  reparentAgentChildWork,
  resumeAgentChildWork
} from './agent-status-child-work-admission-operations'
import { authorizeAgentChildWorkStop } from './agent-status-child-work-stop'
import type { AgentStatusStore } from './agent-status-store'
import type { AgentStatusSubject } from './agent-status-subject'

export type AgentChildWorkObservationAlias = {
  segmentId: string
  aliasKind: AgentChildWorkAliasKind
  alias: string
}

export type AgentChildWorkObservationFields = {
  kind: AgentChildWorkKind
  state: AgentChildWorkState
  membership: AgentChildWorkMembership
  outcome?: AgentChildWorkOutcome
  name?: string
  description?: string
  agentType?: string
  model?: string
  totalTokens?: number
  providerTiming?: AgentChildWorkProviderTiming
  observedAt: number
  stoppable: boolean
  provenance: AgentChildWorkProvenance
}

export type AgentChildWorkAnnounceRequest = AgentChildWorkObservationFields & {
  parent: AgentStatusSubject
  provider: string
  aliases: AgentChildWorkObservationAlias[]
  fence: AgentChildWorkInvocationFence
  lifetime: 'current' | 'proven-new'
}

export type AgentChildWorkAdoptRequest = AgentChildWorkObservationFields & {
  parent: AgentStatusSubject
  provider: string
  childWorkId: AgentChildWorkId
  expectedFence: AgentChildWorkInvocationFence
  aliases: AgentChildWorkObservationAlias[]
}

export type AgentChildWorkResumeRequest = AgentChildWorkObservationFields & {
  parent: AgentStatusSubject
  provider: string
  childWorkId: AgentChildWorkId
  expectedFence: AgentChildWorkInvocationFence
  nextFence: AgentChildWorkInvocationFence
  aliases: AgentChildWorkObservationAlias[]
}

export type AgentChildWorkReparentRequest = {
  childWorkId: AgentChildWorkId
  fromParent: AgentStatusSubject
  toParent: AgentStatusSubject
  expectedFence: AgentChildWorkInvocationFence
  observedAt: number
}

export type AgentChildWorkStopRequest = {
  parent: AgentStatusSubject
  childWorkId: AgentChildWorkId
  expectedFence: AgentChildWorkInvocationFence
}

export type AgentChildWorkAdmissionResult =
  | { accepted: true; childWorkId: AgentChildWorkId; revision: number; created: boolean }
  | {
      accepted: false
      reason:
        | 'invalid'
        | 'ambiguous'
        | 'stale-invocation'
        | 'unknown-child'
        | 'id-collision'
        | 'store-rejected'
    }

export type AgentChildWorkAdmission = {
  announce(request: AgentChildWorkAnnounceRequest): AgentChildWorkAdmissionResult
  adopt(request: AgentChildWorkAdoptRequest): AgentChildWorkAdmissionResult
  resume(request: AgentChildWorkResumeRequest): AgentChildWorkAdmissionResult
  reparent(request: AgentChildWorkReparentRequest): AgentChildWorkAdmissionResult
  authorizeStop(request: AgentChildWorkStopRequest): AgentChildWorkRecord | null
}

export function createAgentChildWorkAdmission(
  store: AgentStatusStore,
  options: { mintChildWorkId: () => AgentChildWorkId }
): AgentChildWorkAdmission {
  return {
    announce: (request) => announceAgentChildWork(store, options.mintChildWorkId, request),
    adopt: (request) => adoptAgentChildWork(store, request),
    resume: (request) => resumeAgentChildWork(store, request),
    reparent: (request) => reparentAgentChildWork(store, request),
    authorizeStop: (request) => authorizeAgentChildWorkStop(store, request)
  }
}
