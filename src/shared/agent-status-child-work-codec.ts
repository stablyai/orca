import {
  AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX,
  AGENT_CHILD_WORK_KINDS,
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

const MAX_ID_LENGTH = 256
const MAX_LABEL_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 8_000
const CHILD_WORK_KIND_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_KINDS)
const CHILD_WORK_STATE_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_STATES)
const CHILD_WORK_MEMBERSHIP_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_MEMBERSHIPS)
const CHILD_WORK_OUTCOME_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_OUTCOMES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(record)
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isBoundedString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

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

function parseProviderTiming(value: unknown): AgentChildWorkProviderTiming | null {
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

function parseOptionalLabel(value: unknown, maxLength = MAX_LABEL_LENGTH): string | null {
  return value === undefined ? '' : isBoundedString(value, maxLength) ? value : null
}

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
        'previousInvocations'
      ]
    ) ||
    !isBoundedString(value.childWorkId) ||
    !isBoundedString(value.provider) ||
    !isKind(value.kind) ||
    !isState(value.state) ||
    !isMembership(value.membership) ||
    (value.outcome !== undefined && !isOutcome(value.outcome)) ||
    (value.outcome !== undefined && value.membership !== 'settled') ||
    !isTimestamp(value.firstObservedAt) ||
    !isTimestamp(value.observedAt) ||
    value.firstObservedAt > value.observedAt ||
    typeof value.stoppable !== 'boolean' ||
    (value.totalTokens !== undefined &&
      (typeof value.totalTokens !== 'number' ||
        !Number.isSafeInteger(value.totalTokens) ||
        value.totalTokens < 0))
  ) {
    return null
  }
  const parent = parseAgentStatusSubject(value.parent)
  const invocation = parseAgentChildWorkInvocationFence(value.invocation)
  const provenance = parseProvenance(value.provenance)
  const timing =
    value.providerTiming === undefined ? undefined : parseProviderTiming(value.providerTiming)
  const history =
    value.previousInvocations === undefined
      ? undefined
      : parseInvocationHistory(value.previousInvocations)
  const labels = {
    name: parseOptionalLabel(value.name),
    description: parseOptionalLabel(value.description, MAX_DESCRIPTION_LENGTH),
    agentType: parseOptionalLabel(value.agentType),
    model: parseOptionalLabel(value.model)
  }
  if (!parent || !invocation || !provenance || timing === null || history === null) {
    return null
  }
  if (Object.values(labels).includes(null)) {
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
    ...(isOutcome(value.outcome) ? { outcome: value.outcome } : {}),
    ...(labels.name ? { name: labels.name } : {}),
    ...(labels.description ? { description: labels.description } : {}),
    ...(labels.agentType ? { agentType: labels.agentType } : {}),
    ...(labels.model ? { model: labels.model } : {}),
    ...(typeof value.totalTokens === 'number' ? { totalTokens: value.totalTokens } : {}),
    ...(timing ? { providerTiming: timing } : {}),
    firstObservedAt: value.firstObservedAt,
    observedAt: value.observedAt,
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
