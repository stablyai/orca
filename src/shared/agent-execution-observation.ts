import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import type {
  AgentStatusRunId,
  AgentStatusRunRole,
  AgentStatusRunVerdict
} from './agent-status-run'
import type { AgentStatusEntry, AgentStatusState } from './agent-status-types'

/** The only execution fact that crosses the host boundary; process details remain host-private. */
export type AgentExecutionObservation = {
  executionId: string
  runId?: AgentStatusRunId
  role?: Exclude<AgentStatusRunRole, 'unresolved'>
  continuityOf?: AgentStatusRunId
  hostId: ExecutionHostId
  hostEpoch: string
  captureRevision: number
  observedAt: number
  inventoryCoverage: 'complete' | 'partial'
  verdict: AgentStatusRunVerdict
}

export function agentExecutionObservationsEqual(
  left: AgentExecutionObservation | undefined,
  right: AgentExecutionObservation | undefined
): boolean {
  if (left === right) {
    return true
  }
  return Boolean(
    left &&
    right &&
    left.executionId === right.executionId &&
    left.runId === right.runId &&
    left.role === right.role &&
    left.continuityOf === right.continuityOf &&
    left.hostId === right.hostId &&
    left.hostEpoch === right.hostEpoch &&
    left.captureRevision === right.captureRevision &&
    left.observedAt === right.observedAt &&
    left.inventoryCoverage === right.inventoryCoverage &&
    left.verdict === right.verdict
  )
}

type RecordValue = Record<string, unknown>
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
  )
}
function hasExactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

/** Fail-closed decoder for host-published evidence. */
export function parseAgentExecutionObservation(value: unknown): AgentExecutionObservation | null {
  const hostId =
    isRecord(value) && typeof value.hostId === 'string'
      ? normalizeExecutionHostId(value.hostId)
      : null
  const captureRevision =
    isRecord(value) &&
    typeof value.captureRevision === 'number' &&
    Number.isSafeInteger(value.captureRevision)
      ? value.captureRevision
      : null
  const observedAt =
    isRecord(value) && typeof value.observedAt === 'number' && Number.isFinite(value.observedAt)
      ? value.observedAt
      : null
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'executionId',
        'hostId',
        'hostEpoch',
        'captureRevision',
        'observedAt',
        'inventoryCoverage',
        'verdict'
      ],
      ['runId', 'role', 'continuityOf']
    ) ||
    !isBoundedString(value.executionId, 128) ||
    !isBoundedString(value.hostId, 1024) ||
    !hostId ||
    !isBoundedString(value.hostEpoch, 256) ||
    captureRevision === null ||
    captureRevision <= 0 ||
    observedAt === null ||
    observedAt < 0 ||
    (value.inventoryCoverage !== 'complete' && value.inventoryCoverage !== 'partial') ||
    (value.verdict !== 'live' && value.verdict !== 'unverifiable' && value.verdict !== 'exited') ||
    (value.runId !== undefined && !isBoundedString(value.runId, 128)) ||
    (value.role !== undefined && value.role !== 'root' && value.role !== 'child') ||
    (value.continuityOf !== undefined && !isBoundedString(value.continuityOf, 128)) ||
    (value.continuityOf !== undefined && value.continuityOf === value.runId) ||
    (value.role !== undefined && value.runId === undefined)
  ) {
    return null
  }
  return {
    executionId: value.executionId,
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.role !== undefined ? { role: value.role } : {}),
    ...(value.continuityOf !== undefined ? { continuityOf: value.continuityOf } : {}),
    hostId,
    hostEpoch: value.hostEpoch,
    captureRevision,
    observedAt,
    inventoryCoverage: value.inventoryCoverage,
    verdict: value.verdict
  }
}

export type AgentExecutionDisplayState = AgentStatusState | 'idle' | 'unverifiable'
export type AgentStatusPresentation = {
  state: AgentExecutionDisplayState
  executionVerdict: AgentStatusRunVerdict | null
  pendingInteraction: boolean
  confidence: 'authoritative' | 'uncertain' | 'legacy'
  routeUsability: 'usable' | 'unverifiable' | 'unavailable'
}

/** Projects status without allowing host liveness to become turn truth. */
export function resolveAgentStatusPresentation(
  entry: Pick<
    AgentStatusEntry,
    | 'state'
    | 'updatedAt'
    | 'evidenceObservedAt'
    | 'mirroredEvidenceReceivedAt'
    | 'restoredUnconfirmed'
    | 'executionObservation'
  >,
  now: number,
  staleAfterMs: number
): AgentStatusPresentation {
  const observation = entry.executionObservation
  const pendingInteraction = entry.state === 'blocked' || entry.state === 'waiting'
  const isFresh =
    entry.restoredUnconfirmed !== true &&
    now - (entry.mirroredEvidenceReceivedAt ?? entry.evidenceObservedAt ?? entry.updatedAt) <=
      staleAfterMs
  if (pendingInteraction) {
    return {
      state: entry.state,
      executionVerdict: observation?.verdict ?? null,
      pendingInteraction: true,
      confidence: observation
        ? observation.verdict === 'live'
          ? 'authoritative'
          : 'uncertain'
        : 'legacy',
      routeUsability: observation
        ? observation.verdict === 'exited'
          ? 'unavailable'
          : 'usable'
        : 'unverifiable'
    }
  }
  if (entry.state === 'done') {
    return {
      state: 'done',
      executionVerdict: observation?.verdict ?? null,
      pendingInteraction: false,
      confidence: observation ? 'authoritative' : 'legacy',
      routeUsability: observation?.verdict === 'exited' ? 'unavailable' : 'usable'
    }
  }
  if (observation) {
    const working = entry.state === 'working' && isFresh && observation.verdict === 'live'
    return {
      state: working ? 'working' : 'unverifiable',
      executionVerdict: observation.verdict,
      pendingInteraction: false,
      confidence: working ? 'authoritative' : 'uncertain',
      routeUsability: observation.verdict === 'exited' ? 'unavailable' : 'usable'
    }
  }
  return {
    state: isFresh ? entry.state : 'idle',
    executionVerdict: null,
    pendingInteraction: false,
    confidence: 'legacy',
    routeUsability: 'usable'
  }
}

export type AgentExecutionAttachment = {
  executionId: string
  runId?: AgentStatusRunId
  role?: Exclude<AgentStatusRunRole, 'unresolved'>
  continuityOf?: AgentStatusRunId
  hostId: ExecutionHostId
  paneKey?: string
  hostEpoch: string
  processIncarnation?: string
  processId?: string
  processIncarnationId?: string
  providerInvocation?: string
}
export type AgentExecutionHostInventory = {
  hostId: ExecutionHostId
  hostEpoch: string
  capturedAt: number
  inventoryCoverage: 'complete' | 'partial'
  processIncarnations: ReadonlySet<string>
  verdictByProcessIncarnation?: ReadonlyMap<string, AgentStatusRunVerdict>
  providerInvocations?: ReadonlySet<string>
}
export type AgentExecutionObservationSchedulerOptions = {
  coalesceMs?: number
  maxConcurrentHostScans?: number
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void
}

export function isExecutionObservationCurrent(
  observation: AgentExecutionObservation | undefined,
  executionId: string,
  hostEpoch: string
): boolean {
  return Boolean(
    observation &&
    observation.executionId === executionId &&
    observation.hostEpoch === hostEpoch &&
    observation.captureRevision > 0
  )
}

export { AgentExecutionObservationScheduler } from './agent-execution-observation-scheduler'
