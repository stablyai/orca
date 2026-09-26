import {
  AGENT_CHILD_WORK_DESCRIPTION_MAX_LENGTH,
  AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX,
  AGENT_CHILD_WORK_KINDS,
  AGENT_CHILD_WORK_LABEL_MAX_LENGTH,
  AGENT_CHILD_WORK_MEMBERSHIPS,
  AGENT_CHILD_WORK_OUTCOMES,
  AGENT_CHILD_WORK_STATES,
  agentChildWorkFencesEqual,
  type AgentChildWorkInput,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkInvocationHistory,
  type AgentChildWorkKind,
  type AgentChildWorkMembership,
  type AgentChildWorkOutcome,
  type AgentChildWorkProviderTiming,
  type AgentChildWorkProvenance,
  type AgentChildWorkRecord,
  type AgentChildWorkState
} from './agent-status-child-work'
import { parseAgentStatusSubject } from './agent-status-subject'
import {
  hasOnlyKeys,
  isBoundedString,
  isChildWorkText,
  isChildWorkTokenCount,
  isRecord,
  isTimestamp
} from './agent-status-child-work-value-guards'
import { parseAgentChildWorkActivityFields } from './agent-status-child-work-activity-codec'
import { isAgentChildWorkLifecycleLegal } from './agent-status-child-work-legality'

const CHILD_WORK_KIND_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_KINDS)
const CHILD_WORK_STATE_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_STATES)
const CHILD_WORK_MEMBERSHIP_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_MEMBERSHIPS)
const CHILD_WORK_OUTCOME_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_OUTCOMES)

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function isKind(value: unknown): value is AgentChildWorkKind {
  return typeof value === 'string' && CHILD_WORK_KIND_SET.has(value)
}

function isState(value: unknown): value is AgentChildWorkState {
  return typeof value === 'string' && CHILD_WORK_STATE_SET.has(value)
}

function isMembership(value: unknown): value is AgentChildWorkMembership {
  return typeof value === 'string' && CHILD_WORK_MEMBERSHIP_SET.has(value)
}

function isOutcome(value: unknown): value is AgentChildWorkOutcome {
  return typeof value === 'string' && CHILD_WORK_OUTCOME_SET.has(value)
}

export function parseAgentChildWorkInvocationFence(
  value: unknown
): AgentChildWorkInvocationFence | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['invocationId', 'generation']) ||
    !isBoundedString(value.invocationId) ||
    !isRevision(value.generation)
  ) {
    return null
  }
  return { invocationId: value.invocationId, generation: value.generation }
}

export function parseAgentChildWorkProviderTiming(
  value: unknown
): AgentChildWorkProviderTiming | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [], ['startedAt', 'completedAt'])) {
    return null
  }
  if (
    (value.startedAt !== undefined && !isTimestamp(value.startedAt)) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt))
  ) {
    return null
  }
  return {
    ...(isTimestamp(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isTimestamp(value.completedAt) ? { completedAt: value.completedAt } : {})
  }
}

function parseProvenance(value: unknown): AgentChildWorkProvenance | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['source', 'producerId']) ||
    (value.source !== 'hook' &&
      value.source !== 'structured-session' &&
      value.source !== 'restore' &&
      value.source !== 'transport') ||
    !isBoundedString(value.producerId)
  ) {
    return null
  }
  return { source: value.source, producerId: value.producerId }
}

function parseInvocationHistory(value: unknown): AgentChildWorkInvocationHistory[] | null {
  if (!Array.isArray(value) || value.length > AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX) {
    return null
  }
  const history: AgentChildWorkInvocationHistory[] = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['fence'], ['outcome', 'settledAt']) ||
      (candidate.outcome !== undefined && !isOutcome(candidate.outcome)) ||
      (candidate.settledAt !== undefined && !isTimestamp(candidate.settledAt))
    ) {
      return null
    }
    const fence = parseAgentChildWorkInvocationFence(candidate.fence)
    if (!fence) {
      return null
    }
    history.push({
      fence,
      ...(isOutcome(candidate.outcome) ? { outcome: candidate.outcome } : {}),
      ...(isTimestamp(candidate.settledAt) ? { settledAt: candidate.settledAt } : {})
    })
  }
  return history
}

function parseOptionalLabel(
  value: unknown,
  maxLength = AGENT_CHILD_WORK_LABEL_MAX_LENGTH
): string | null {
  return value === undefined ? '' : isChildWorkText(value, maxLength) ? value : null
}

/** The host's integrity gate for its own store, strict by design: an unknown key or enum arm
 *  rejects the whole record. Never a cross-version decoder — anything reading records or views
 *  from another build must ignore unknown keys and degrade unknown arms, or negotiate
 *  (docs/reference/remote-wire-compatibility.md, Rules 1 and 4).
 *  Every malformed field rejects, descriptive or not: admission drops bad provider facts before
 *  they get here, so a value outside its image is a writer bug, never data to repair silently. */
export function parseAgentChildWorkInput(value: unknown): AgentChildWorkInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'childWorkId',
        'parent',
        'provider',
        'kind',
        'state',
        'membership',
        'firstObservedAt',
        'observedAt',
        'stoppable',
        'invocation',
        'provenance'
      ],
      [
        'outcome',
        'name',
        'description',
        'agentType',
        'model',
        'totalTokens',
        'providerTiming',
        'parentChildWorkId',
        'residency',
        'operation',
        'lastMessage',
        'settledAt',
        'previousInvocations'
      ]
    ) ||
    !isBoundedString(value.childWorkId) ||
    !isBoundedString(value.provider) ||
    !isKind(value.kind) ||
    !isState(value.state) ||
    !isMembership(value.membership) ||
    (value.outcome !== undefined && !isOutcome(value.outcome)) ||
    (value.settledAt !== undefined && !isTimestamp(value.settledAt)) ||
    !isTimestamp(value.firstObservedAt) ||
    !isTimestamp(value.observedAt) ||
    value.firstObservedAt > value.observedAt ||
    typeof value.stoppable !== 'boolean' ||
    (value.totalTokens !== undefined && !isChildWorkTokenCount(value.totalTokens))
  ) {
    return null
  }
  const parent = parseAgentStatusSubject(value.parent)
  const invocation = parseAgentChildWorkInvocationFence(value.invocation)
  const provenance = parseProvenance(value.provenance)
  const timing =
    value.providerTiming === undefined
      ? undefined
      : parseAgentChildWorkProviderTiming(value.providerTiming)
  const history =
    value.previousInvocations === undefined
      ? undefined
      : parseInvocationHistory(value.previousInvocations)
  const labels = {
    name: parseOptionalLabel(value.name),
    description: parseOptionalLabel(value.description, AGENT_CHILD_WORK_DESCRIPTION_MAX_LENGTH),
    agentType: parseOptionalLabel(value.agentType),
    model: parseOptionalLabel(value.model)
  }
  const activity = parseAgentChildWorkActivityFields(value, {
    childWorkId: value.childWorkId,
    firstObservedAt: value.firstObservedAt,
    observedAt: value.observedAt
  })
  if (
    !parent ||
    !invocation ||
    !provenance ||
    timing === null ||
    history === null ||
    !activity ||
    Object.values(labels).includes(null)
  ) {
    return null
  }
  // A settled record written without these fields (an older writer) reads as an unknown ending
  // at its last evidence, never as success.
  const settled = value.membership === 'settled'
  const outcome = isOutcome(value.outcome) ? value.outcome : settled ? 'unknown' : undefined
  const settledAt = isTimestamp(value.settledAt)
    ? value.settledAt
    : settled
      ? value.observedAt
      : undefined
  if (
    !isAgentChildWorkLifecycleLegal({
      kind: value.kind,
      state: value.state,
      membership: value.membership,
      outcome,
      settledAt,
      operation: activity.operation,
      firstObservedAt: value.firstObservedAt,
      observedAt: value.observedAt
    })
  ) {
    return null
  }
  const historyFenceKeys = history?.map(
    (entry) => `${entry.fence.invocationId}\0${entry.fence.generation}`
  )
  if (
    history &&
    historyFenceKeys &&
    (new Set(historyFenceKeys).size !== historyFenceKeys.length ||
      history.some((entry) => agentChildWorkFencesEqual(entry.fence, invocation)))
  ) {
    return null
  }
  return {
    childWorkId: value.childWorkId,
    parent,
    provider: value.provider,
    kind: value.kind,
    state: value.state,
    membership: value.membership,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(labels.name ? { name: labels.name } : {}),
    ...(labels.description ? { description: labels.description } : {}),
    ...(labels.agentType ? { agentType: labels.agentType } : {}),
    ...(labels.model ? { model: labels.model } : {}),
    ...(typeof value.totalTokens === 'number' ? { totalTokens: value.totalTokens } : {}),
    ...(timing ? { providerTiming: timing } : {}),
    ...activity,
    firstObservedAt: value.firstObservedAt,
    observedAt: value.observedAt,
    ...(settledAt !== undefined ? { settledAt } : {}),
    stoppable: value.stoppable,
    invocation,
    ...(history ? { previousInvocations: history } : {}),
    provenance
  }
}

export function parseAgentChildWorkRecord(value: unknown): AgentChildWorkRecord | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null
  }
  const input = { ...value }
  delete input.revision
  const parsed = parseAgentChildWorkInput(input)
  return parsed ? { ...parsed, revision: value.revision } : null
}
