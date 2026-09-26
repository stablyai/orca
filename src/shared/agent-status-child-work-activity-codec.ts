import {
  AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH,
  AGENT_CHILD_WORK_OPERATION_BASES,
  AGENT_CHILD_WORK_RESIDENCIES,
  type AgentChildWorkInput,
  type AgentChildWorkOperation,
  type AgentChildWorkOperationBasis,
  type AgentChildWorkResidency
} from './agent-status-child-work'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import {
  hasOnlyKeys,
  isBoundedString,
  isChildWorkText,
  isRecord,
  isTimestamp
} from './agent-status-child-work-value-guards'

const RESIDENCY_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_RESIDENCIES)
const OPERATION_BASIS_SET: ReadonlySet<string> = new Set(AGENT_CHILD_WORK_OPERATION_BASES)

export type AgentChildWorkActivityFields = Pick<
  AgentChildWorkInput,
  'parentChildWorkId' | 'residency' | 'operation' | 'lastMessage'
>

type AgentChildWorkActivityClock = Pick<
  AgentChildWorkInput,
  'childWorkId' | 'firstObservedAt' | 'observedAt'
>

export function isAgentChildWorkResidency(value: unknown): value is AgentChildWorkResidency {
  return typeof value === 'string' && RESIDENCY_SET.has(value)
}

export function isAgentChildWorkOperationBasis(
  value: unknown
): value is AgentChildWorkOperationBasis {
  return typeof value === 'string' && OPERATION_BASIS_SET.has(value)
}

/** An owner is another child's id; a child never owns itself. */
export function isAgentChildWorkOwner(value: unknown, childWorkId: string): value is string {
  return isBoundedString(value) && value !== childWorkId
}

function parseOperation(
  value: unknown,
  clock: AgentChildWorkActivityClock
): AgentChildWorkOperation | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['toolName', 'basis', 'observedAt'], ['input']) ||
    !isChildWorkText(value.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH) ||
    (value.input !== undefined &&
      !isChildWorkText(value.input, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)) ||
    !isAgentChildWorkOperationBasis(value.basis) ||
    !isTimestamp(value.observedAt) ||
    // The record's own clock is the newest evidence for this child, so it bounds the operation's.
    value.observedAt < clock.firstObservedAt ||
    value.observedAt > clock.observedAt
  ) {
    return null
  }
  return {
    toolName: value.toolName,
    ...(typeof value.input === 'string' ? { input: value.input } : {}),
    basis: value.basis,
    observedAt: value.observedAt
  }
}

/** Null when any present field is outside what admission can produce. */
export function parseAgentChildWorkActivityFields(
  value: Record<string, unknown>,
  clock: AgentChildWorkActivityClock
): AgentChildWorkActivityFields | null {
  const operation =
    value.operation === undefined ? undefined : parseOperation(value.operation, clock)
  if (
    operation === null ||
    (value.parentChildWorkId !== undefined &&
      !isAgentChildWorkOwner(value.parentChildWorkId, clock.childWorkId)) ||
    (value.residency !== undefined && !isAgentChildWorkResidency(value.residency)) ||
    (value.lastMessage !== undefined &&
      !isChildWorkText(value.lastMessage, AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH))
  ) {
    return null
  }
  return {
    ...(typeof value.parentChildWorkId === 'string'
      ? { parentChildWorkId: value.parentChildWorkId }
      : {}),
    ...(isAgentChildWorkResidency(value.residency) ? { residency: value.residency } : {}),
    ...(operation ? { operation } : {}),
    ...(typeof value.lastMessage === 'string' ? { lastMessage: value.lastMessage } : {})
  }
}
