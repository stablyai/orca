import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  agentChildWorkFencesEqual,
  type AgentChildWorkId,
  type AgentChildWorkInput,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkKind,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import { parseAgentChildWorkInput } from './agent-status-child-work-codec'
import type {
  AgentChildWorkAdmissionResult,
  AgentChildWorkAdoptRequest,
  AgentChildWorkAnnounceRequest,
  AgentChildWorkObservationAlias,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'

const MAX_ALIASES_PER_ADMISSION = 32

export function rejectAgentChildWorkAdmission(
  reason: Extract<AgentChildWorkAdmissionResult, { accepted: false }>['reason']
) {
  return { accepted: false, reason } as const
}

export function findAgentChildWork(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkRecord | null {
  return store.getChild(childWorkId)
}

export function agentChildWorkAliasesForChild(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkAliasRecord[] {
  return store.getAliasesForChild(childWorkId)
}

export function buildAgentChildWorkAliases(
  parent: AgentStatusSubject,
  provider: string,
  kind: AgentChildWorkKind,
  aliases: AgentChildWorkObservationAlias[],
  childWorkId: AgentChildWorkId,
  fence: AgentChildWorkInvocationFence
): AgentChildWorkAliasInput[] | null {
  if (aliases.length === 0 || aliases.length > MAX_ALIASES_PER_ADMISSION) {
    return null
  }
  const built: AgentChildWorkAliasInput[] = []
  const keys = new Set<string>()
  try {
    for (const alias of aliases) {
      const candidate = { parent, provider, kind, ...alias, childWorkId, fence }
      const key = serializeAgentChildWorkAliasKey(candidate)
      if (keys.has(key)) {
        return null
      }
      keys.add(key)
      built.push(candidate)
    }
  } catch {
    return null
  }
  return built
}

export function buildAgentChildWork(
  request: AgentChildWorkObservationFields & {
    parent: AgentStatusSubject
    provider: string
  },
  childWorkId: string,
  firstObservedAt: number,
  invocation: AgentChildWorkInvocationFence,
  previousInvocations?: AgentChildWorkInput['previousInvocations']
): AgentChildWorkInput | null {
  return parseAgentChildWorkInput({
    childWorkId,
    parent: request.parent,
    provider: request.provider,
    kind: request.kind,
    state: request.state,
    membership: request.membership,
    ...(request.outcome !== undefined ? { outcome: request.outcome } : {}),
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.totalTokens !== undefined ? { totalTokens: request.totalTokens } : {}),
    ...(request.providerTiming !== undefined ? { providerTiming: request.providerTiming } : {}),
    firstObservedAt,
    observedAt: request.observedAt,
    stoppable: request.stoppable,
    invocation,
    ...(previousInvocations !== undefined ? { previousInvocations } : {}),
    provenance: request.provenance
  })
}

export function commitAgentChildWork(
  store: AgentStatusStore,
  child: AgentChildWorkInput,
  aliases: AgentChildWorkAliasInput[],
  created: boolean,
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  const envelope = store.applyMutation({
    children: [child],
    aliases,
    ...(removeAliases.length > 0 ? { removeAliases } : {})
  })
  return envelope
    ? { accepted: true, childWorkId: child.childWorkId, revision: envelope.revision, created }
    : rejectAgentChildWorkAdmission('store-rejected')
}

export function updateExistingAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkAnnounceRequest | AgentChildWorkAdoptRequest,
  child: AgentChildWorkRecord,
  aliases: AgentChildWorkAliasInput[],
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  const updated = buildAgentChildWork(
    request,
    child.childWorkId,
    child.firstObservedAt,
    child.invocation,
    child.previousInvocations
  )
  return updated
    ? commitAgentChildWork(store, updated, aliases, false, removeAliases)
    : rejectAgentChildWorkAdmission('invalid')
}

export function resolveAgentChildWorkAliasRecords(
  store: AgentStatusStore,
  aliases: AgentChildWorkAliasInput[]
): AgentChildWorkAliasRecord[] {
  return aliases.flatMap((alias) => {
    const found = store.getAlias(alias)
    return found ? [found] : []
  })
}

export function validateExistingAgentChildWork(
  child: AgentChildWorkRecord | null,
  parent: AgentStatusSubject,
  provider: string,
  expectedFence: AgentChildWorkInvocationFence
): AgentChildWorkAdmissionResult | null {
  if (!child) {
    return rejectAgentChildWorkAdmission('unknown-child')
  }
  if (!agentStatusSubjectsEqual(child.parent, parent) || child.provider !== provider) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  if (!agentChildWorkFencesEqual(child.invocation, expectedFence)) {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  return null
}
