import { serializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import { agentChildWorkFencesEqual, type AgentChildWorkId } from './agent-status-child-work'
import {
  agentChildWorkAliasesForChild,
  agentChildWorkSettledAt,
  buildAgentChildWork,
  buildAgentChildWorkAliases,
  commitAgentChildWork,
  findAgentChildWork,
  rejectAgentChildWorkAdmission,
  resolveAgentChildWorkAliasRecords,
  updateExistingAgentChildWork,
  validateExistingAgentChildWork
} from './agent-status-child-work-admission-core'
import type {
  AgentChildWorkAdmissionResult,
  AgentChildWorkAdoptRequest,
  AgentChildWorkAnnounceRequest,
  AgentChildWorkReparentRequest
} from './agent-status-child-work-admission'
import {
  parseAgentChildWorkInput,
  parseAgentChildWorkInvocationFence
} from './agent-status-child-work-codec'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, parseAgentStatusSubject } from './agent-status-subject'

export function announceAgentChildWork(
  store: AgentStatusStore,
  mintChildWorkId: () => AgentChildWorkId,
  request: AgentChildWorkAnnounceRequest
): AgentChildWorkAdmissionResult {
  const parent = parseAgentStatusSubject(request.parent)
  const fence = parseAgentChildWorkInvocationFence(request.fence)
  if (!parent || !fence || !store.getParent(parent)) {
    return rejectAgentChildWorkAdmission('invalid')
  }
  const lookupAliases = buildAgentChildWorkAliases(
    parent,
    request.provider,
    request.kind,
    request.aliases,
    'unresolved-child',
    fence
  )
  if (!lookupAliases) {
    return rejectAgentChildWorkAdmission('invalid')
  }
  const bindings = resolveAgentChildWorkAliasRecords(store, lookupAliases)
  const exact = bindings.filter((binding) => agentChildWorkFencesEqual(binding.fence, fence))
  const exactIds = new Set(exact.map((binding) => binding.childWorkId))
  if (request.lifetime === 'proven-new') {
    if (exact.length > 0) {
      return rejectAgentChildWorkAdmission('id-collision')
    }
    const candidateId = mintChildWorkId()
    const aliases = buildAgentChildWorkAliases(
      parent,
      request.provider,
      request.kind,
      request.aliases,
      candidateId,
      fence
    )
    if (!aliases || findAgentChildWork(store, candidateId)) {
      return rejectAgentChildWorkAdmission(aliases ? 'id-collision' : 'invalid')
    }
    const child = buildAgentChildWork(request, {
      childWorkId: candidateId,
      firstObservedAt: request.observedAt,
      invocation: fence,
      settledAt: agentChildWorkSettledAt(request)
    })
    return child
      ? commitAgentChildWork(store, child, aliases, true)
      : rejectAgentChildWorkAdmission('invalid')
  }
  if ((exact.length === 0 && bindings.length > 0) || exactIds.size > 1) {
    return rejectAgentChildWorkAdmission(exactIds.size > 1 ? 'ambiguous' : 'stale-invocation')
  }
  const existingId = exact[0]?.childWorkId
  if (existingId) {
    const child = findAgentChildWork(store, existingId)
    if (
      !child ||
      !agentStatusSubjectsEqual(child.parent, parent) ||
      child.provider !== request.provider ||
      child.kind !== request.kind
    ) {
      return rejectAgentChildWorkAdmission('ambiguous')
    }
    if (!agentChildWorkFencesEqual(child.invocation, fence)) {
      return rejectAgentChildWorkAdmission('stale-invocation')
    }
    const aliases = buildAgentChildWorkAliases(
      parent,
      request.provider,
      request.kind,
      request.aliases,
      child.childWorkId,
      fence
    )
    return aliases
      ? updateExistingAgentChildWork(store, request, child, aliases)
      : rejectAgentChildWorkAdmission('invalid')
  }
  const candidateId = mintChildWorkId()
  if (findAgentChildWork(store, candidateId)) {
    return rejectAgentChildWorkAdmission('id-collision')
  }
  const aliases = buildAgentChildWorkAliases(
    parent,
    request.provider,
    request.kind,
    request.aliases,
    candidateId,
    fence
  )
  const child = buildAgentChildWork(request, {
    childWorkId: candidateId,
    firstObservedAt: request.observedAt,
    invocation: fence,
    settledAt: agentChildWorkSettledAt(request)
  })
  return aliases && child
    ? commitAgentChildWork(store, child, aliases, true)
    : rejectAgentChildWorkAdmission('invalid')
}

export function adoptAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkAdoptRequest
): AgentChildWorkAdmissionResult {
  const child = findAgentChildWork(store, request.childWorkId)
  const invalid = validateExistingAgentChildWork(
    child,
    request.parent,
    request.provider,
    request.expectedFence
  )
  if (invalid || !child) {
    return invalid ?? rejectAgentChildWorkAdmission('unknown-child')
  }
  const aliases = buildAgentChildWorkAliases(
    request.parent,
    request.provider,
    request.kind,
    request.aliases,
    child.childWorkId,
    child.invocation
  )
  if (!aliases) {
    return rejectAgentChildWorkAdmission('invalid')
  }
  const collisions = resolveAgentChildWorkAliasRecords(store, aliases).filter(
    (binding) => binding.childWorkId !== child.childWorkId
  )
  if (collisions.length > 0) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  const oldAliases = agentChildWorkAliasesForChild(store, child.childWorkId)
  const removeAliases = oldAliases
    .filter((alias) => alias.kind !== request.kind)
    .map(serializeAgentChildWorkBindingKey)
  const reclassified = oldAliases.map((alias) => ({
    parent: alias.parent,
    provider: alias.provider,
    segmentId: alias.segmentId,
    kind: request.kind,
    aliasKind: alias.aliasKind,
    alias: alias.alias,
    childWorkId: alias.childWorkId,
    fence: alias.fence
  }))
  const unique = new Map(
    [...reclassified, ...aliases].map((alias) => [serializeAgentChildWorkBindingKey(alias), alias])
  )
  const reclassifiedCollisions = resolveAgentChildWorkAliasRecords(store, [
    ...unique.values()
  ]).filter((binding) => binding.childWorkId !== child.childWorkId)
  if (reclassifiedCollisions.length > 0) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  return updateExistingAgentChildWork(store, request, child, [...unique.values()], removeAliases)
}

export function reparentAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkReparentRequest
): AgentChildWorkAdmissionResult {
  const child = findAgentChildWork(store, request.childWorkId)
  if (
    !child ||
    !agentStatusSubjectsEqual(child.parent, request.fromParent) ||
    !agentChildWorkFencesEqual(child.invocation, request.expectedFence) ||
    !store.getParent(request.toParent) ||
    request.observedAt < child.observedAt
  ) {
    return rejectAgentChildWorkAdmission(child ? 'stale-invocation' : 'unknown-child')
  }
  const oldAliases = agentChildWorkAliasesForChild(store, child.childWorkId)
  const aliases = oldAliases.map((alias) => ({
    parent: request.toParent,
    provider: alias.provider,
    segmentId: alias.segmentId,
    kind: alias.kind,
    aliasKind: alias.aliasKind,
    alias: alias.alias,
    childWorkId: alias.childWorkId,
    fence: alias.fence
  }))
  const collisions = resolveAgentChildWorkAliasRecords(store, aliases).filter(
    (binding) => binding.childWorkId !== child.childWorkId
  )
  if (collisions.length > 0) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  const { revision: _revision, ...childInput } = child
  const moved = parseAgentChildWorkInput({
    ...childInput,
    parent: request.toParent,
    observedAt: request.observedAt
  })
  return moved
    ? commitAgentChildWork(
        store,
        moved,
        aliases,
        false,
        oldAliases.map(serializeAgentChildWorkBindingKey)
      )
    : rejectAgentChildWorkAdmission('invalid')
}
