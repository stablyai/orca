import { isAgentHookSource } from './agent-hook-relay'
import { isAgentStatusExecutionId, isAgentStatusRunId } from './agent-status-run'
import { parseAgentStatusExecutionScope } from './agent-status-subject'
import type {
  AgentCurrentTurnInventory,
  AgentTurnEvidence,
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleState,
  AgentTurnOwner,
  AgentTurnOutcome
} from './agent-turn-lifecycle-contract'

export const AGENT_TURN_MAX_TURNS = 128
export const AGENT_TURN_MAX_WORK_ITEMS = 512
export const AGENT_TURN_MAX_DISPATCHES = 256
export const AGENT_TURN_MAX_RECOVERIES = 128
export const AGENT_TURN_MAX_APPLIED_EVENTS = 1024
export const AGENT_TURN_MAX_INTEGRITY_ISSUES = 128

const MAX_LIFECYCLE_ID_LENGTH = 512

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isAgentTurnLifecycleId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LIFECYCLE_ID_LENGTH ||
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

export function isAgentTurnEvidence(value: unknown): value is AgentTurnEvidence {
  if (!isRecord(value)) {
    return false
  }
  return (
    isAgentTurnLifecycleId(value.eventId) &&
    isAgentTurnLifecycleId(value.producerId) &&
    isFiniteTimestamp(value.observedAt) &&
    (value.cursor === undefined || isAgentTurnLifecycleId(value.cursor))
  )
}

export function isAgentTurnOwner(value: unknown): value is AgentTurnOwner {
  if (!isRecord(value) || !isRecord(value.attachment)) {
    return false
  }
  const scope = {
    executionHostId: value.executionHostId,
    wslDistro: value.wslDistro,
    workspaceId: value.workspaceId,
    workspaceKind: value.workspaceKind
  }
  return (
    parseAgentStatusExecutionScope(scope) !== null &&
    isAgentStatusRunId(value.runId) &&
    isAgentStatusExecutionId(value.attachment.executionId) &&
    isAgentHookSource(value.provider)
  )
}

export function agentTurnOwnersEqual(left: AgentTurnOwner, right: AgentTurnOwner): boolean {
  return (
    left.executionHostId === right.executionHostId &&
    left.wslDistro === right.wslDistro &&
    left.workspaceId === right.workspaceId &&
    left.workspaceKind === right.workspaceKind &&
    left.runId === right.runId &&
    left.attachment.executionId === right.attachment.executionId &&
    left.provider === right.provider
  )
}

export function createAgentTurnLifecycleState(owner: AgentTurnOwner): AgentTurnLifecycleState {
  if (!isAgentTurnOwner(owner)) {
    throw new Error('Invalid agent turn owner')
  }
  return {
    version: 1,
    owner: { ...owner, attachment: { ...owner.attachment } },
    currentTurnId: null,
    turns: [],
    work: [],
    dispatches: [],
    recoveries: [],
    executionVerdict: 'unverifiable',
    integrityIssues: [],
    appliedEvents: []
  }
}

function completionOwnerTuple(owner: AgentTurnOwner): readonly (string | null)[] {
  return [
    owner.executionHostId,
    owner.wslDistro,
    owner.workspaceId,
    owner.workspaceKind,
    owner.runId,
    owner.attachment.executionId,
    owner.provider
  ]
}

export function agentTurnCompletionId(
  owner: AgentTurnOwner,
  turnId: string,
  outcome: AgentTurnOutcome
): string {
  return `agent-turn-completion-v1:${JSON.stringify([...completionOwnerTuple(owner), turnId, outcome])}`
}

export function agentTurnDispatchSettlementId(
  owner: AgentTurnOwner,
  dispatchId: string,
  turnId: string
): string {
  return `agent-turn-dispatch-v1:${JSON.stringify([
    ...completionOwnerTuple(owner),
    dispatchId,
    turnId
  ])}`
}

function isTurnOutcome(value: unknown): value is AgentTurnOutcome {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
}

function isOptionalTimestamp(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isFiniteTimestamp(record[key])
}

function isInventoryWork(
  value: unknown
): value is AgentCurrentTurnInventory['joinedChildren'][number] {
  if (!isRecord(value) || !isAgentTurnLifecycleId(value.workId)) {
    return false
  }
  if (value.phase !== 'active' && value.phase !== 'settled' && value.phase !== 'unresolved') {
    return false
  }
  if (!isOptionalTimestamp(value, 'startedAt') || !isOptionalTimestamp(value, 'settledAt')) {
    return false
  }
  if (value.outcome !== undefined && !isTurnOutcome(value.outcome)) {
    return false
  }
  if ((value.phase === 'active' || value.phase === 'unresolved') && value.outcome !== undefined) {
    return false
  }
  return true
}

function isInventory(value: unknown): value is AgentCurrentTurnInventory {
  if (!isRecord(value) || !isAgentTurnLifecycleId(value.turnId)) {
    return false
  }
  if (!isOptionalTimestamp(value, 'startedAt')) {
    return false
  }
  if (
    !Array.isArray(value.joinedChildren) ||
    !Array.isArray(value.residentBackground) ||
    value.joinedChildren.length > AGENT_TURN_MAX_WORK_ITEMS ||
    value.residentBackground.length > AGENT_TURN_MAX_WORK_ITEMS
  ) {
    return false
  }
  if (
    !value.joinedChildren.every(isInventoryWork) ||
    !value.residentBackground.every(isInventoryWork)
  ) {
    return false
  }
  const workIds = [...value.joinedChildren, ...value.residentBackground].map((item) => item.workId)
  return new Set(workIds).size === workIds.length
}

function hasEventBase(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isAgentTurnOwner(value.owner) && isAgentTurnEvidence(value.evidence)
}

export function isAgentTurnLifecycleEvent(value: unknown): value is AgentTurnLifecycleEvent {
  if (!hasEventBase(value)) {
    return false
  }
  const kind = value.kind
  if (
    !isAgentTurnLifecycleId(value.turnId) &&
    kind !== 'current-turn-inventory' &&
    kind !== 'execution-verdict-observed'
  ) {
    return false
  }
  switch (kind) {
    case 'turn-started':
      return isOptionalTimestamp(value, 'startedAt')
    case 'turn-outcome-observed':
      return (
        (value.outcome === 'completed' || value.outcome === 'failed') &&
        (value.recordKind === 'event' || value.recordKind === 'terminal-record') &&
        isOptionalTimestamp(value, 'settledAt')
      )
    case 'turn-interrupt-requested':
      return true
    case 'turn-interrupt-input-written':
      return isOptionalTimestamp(value, 'writtenAt')
    case 'turn-interrupt-acknowledged':
      return isOptionalTimestamp(value, 'settledAt')
    case 'work-started':
      return (
        isAgentTurnLifecycleId(value.workId) &&
        (value.workKind === 'joined-child' || value.workKind === 'resident-background') &&
        isOptionalTimestamp(value, 'startedAt')
      )
    case 'work-outcome-observed':
      return (
        isAgentTurnLifecycleId(value.workId) &&
        (value.workKind === 'joined-child' || value.workKind === 'resident-background') &&
        isTurnOutcome(value.outcome) &&
        isOptionalTimestamp(value, 'settledAt')
      )
    case 'current-turn-inventory':
      return (
        value.complete === true && (value.currentTurn === null || isInventory(value.currentTurn))
      )
    case 'turn-recovery-started':
      if (!isAgentTurnEvidence(value.evidence)) {
        return false
      }
      return (
        isAgentTurnLifecycleId(value.custodyId) &&
        isFiniteTimestamp(value.deadlineAt) &&
        value.deadlineAt > value.evidence.observedAt
      )
    case 'turn-recovery-expired':
    case 'turn-recovery-abandoned':
      return isAgentTurnLifecycleId(value.custodyId)
    case 'execution-verdict-observed':
      return (
        value.verdict === 'live' || value.verdict === 'unverifiable' || value.verdict === 'exited'
      )
    case 'dispatch-associated':
    case 'dispatch-received':
    case 'dispatch-rejected':
    case 'dispatch-abandoned':
      return isAgentTurnLifecycleId(value.dispatchId)
    default:
      return false
  }
}
