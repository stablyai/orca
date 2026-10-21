import { serializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import {
  AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX,
  agentChildWorkFencesEqual
} from './agent-status-child-work'
import {
  agentChildWorkAliasesForChild,
  agentChildWorkSettledAt,
  buildAgentChildWork,
  buildAgentChildWorkAliases,
  commitAgentChildWork,
  findAgentChildWork,
  rejectAgentChildWorkAdmission,
  resolveAgentChildWorkAliasRecords,
  validateExistingAgentChildWork
} from './agent-status-child-work-admission-core'
import type {
  AgentChildWorkAdmissionResult,
  AgentChildWorkResumeRequest
} from './agent-status-child-work-admission'
import { parseAgentChildWorkInvocationFence } from './agent-status-child-work-codec'
import type { AgentStatusStore } from './agent-status-store'

export function resumeAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkResumeRequest
): AgentChildWorkAdmissionResult {
  const child = findAgentChildWork(store, request.childWorkId)
  const invalid = validateExistingAgentChildWork(
    child,
    request.parent,
    request.provider,
    request.expectedFence
  )
  const nextFence = parseAgentChildWorkInvocationFence(request.nextFence)
  if (invalid || !child) {
    return invalid ?? rejectAgentChildWorkAdmission('unknown-child')
  }
  if (!nextFence) {
    return rejectAgentChildWorkAdmission('invalid')
  }
  if (nextFence.generation <= child.invocation.generation) {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  const aliases = buildAgentChildWorkAliases(
    request.parent,
    request.provider,
    request.kind,
    request.aliases,
    child.childWorkId,
    nextFence
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
  const previousInvocations = [
    ...(child.previousInvocations ?? []),
    {
      fence: child.invocation,
      ...(child.outcome !== undefined ? { outcome: child.outcome } : {}),
      ...(child.settledAt !== undefined ? { settledAt: child.settledAt } : {})
    }
  ].slice(-AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX)
  const resumed = buildAgentChildWork(
    request,
    {
      childWorkId: child.childWorkId,
      firstObservedAt: child.firstObservedAt,
      invocation: nextFence,
      previousInvocations,
      settledAt: agentChildWorkSettledAt(request)
    },
    child
  )
  const retainedFences = [nextFence, ...previousInvocations.map((entry) => entry.fence)]
  const removeAliases = agentChildWorkAliasesForChild(store, child.childWorkId)
    .filter(
      (alias) => !retainedFences.some((fence) => agentChildWorkFencesEqual(fence, alias.fence))
    )
    .map(serializeAgentChildWorkBindingKey)
  return resumed
    ? commitAgentChildWork(store, resumed, aliases, false, removeAliases)
    : rejectAgentChildWorkAdmission('invalid')
}
