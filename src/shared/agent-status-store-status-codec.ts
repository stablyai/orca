import { normalizeAgentProviderSession } from './agent-session-resume'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import {
  isAgentStatusExecutionId,
  isAgentStatusRunId,
  parseAgentStatusProviderAlias
} from './agent-status-run'
import { normalizeAgentStatusPayload } from './agent-status-types'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { measureUtf8ByteLength } from './utf8-byte-limits'

const MAX_STATUS_BYTES = 256 * 1024
const MAX_ID_LENGTH = 4_096
const STATUS_STRUCTURE_LIMITS = { structuralTokens: 16_384, nestingDepth: 24 } as const

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

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !value.includes('\0')
  )
}

function copyJsonRecord(value: unknown): Record<string, unknown> | null {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return null
  }
  if (measureUtf8ByteLength(serialized, { stopAfterBytes: MAX_STATUS_BYTES }).exceededLimit) {
    return null
  }
  try {
    assertJsonTextStructureWithinLimits(serialized, STATUS_STRUCTURE_LIMITS)
    const parsed: unknown = JSON.parse(serialized)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseObservation(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['origin', 'authorityId', 'incarnation', 'revision', 'observedAt'],
      ['boundary', 'kind']
    ) ||
    (value.origin !== 'hook' &&
      value.origin !== 'osc' &&
      value.origin !== 'title' &&
      value.origin !== 'process' &&
      value.origin !== 'launch' &&
      value.origin !== 'orchestration' &&
      value.origin !== 'structured') ||
    !isBoundedString(value.authorityId) ||
    !isRevision(value.incarnation) ||
    !isRevision(value.revision) ||
    !isTimestamp(value.observedAt) ||
    (value.boundary !== undefined && value.boundary !== true) ||
    (value.kind !== undefined &&
      value.kind !== 'transition' &&
      value.kind !== 'snapshot' &&
      value.kind !== 'identity-only')
  ) {
    return null
  }
  return {
    origin: value.origin,
    authorityId: value.authorityId,
    incarnation: value.incarnation,
    revision: value.revision,
    observedAt: value.observedAt,
    ...(value.boundary === true ? { boundary: true } : {}),
    ...(value.kind !== undefined ? { kind: value.kind } : {})
  }
}

function parseOrchestration(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isBoundedString(value.taskId) || !isBoundedString(value.dispatchId)) {
    return null
  }
  const optionalStrings = [
    'taskTitle',
    'displayName',
    'parentTerminalHandle',
    'parentPaneKey',
    'coordinatorHandle',
    'orchestrationRunId'
  ]
  if (optionalStrings.some((key) => value[key] !== undefined && !isBoundedString(value[key]))) {
    return null
  }
  if (
    value.dispatchStatus !== undefined &&
    value.dispatchStatus !== 'pending' &&
    value.dispatchStatus !== 'dispatched' &&
    value.dispatchStatus !== 'completed' &&
    value.dispatchStatus !== 'failed' &&
    value.dispatchStatus !== 'circuit_broken'
  ) {
    return null
  }
  if (value.attention !== undefined && !isRecord(value.attention)) {
    return null
  }
  return { ...value }
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
): boolean {
  const value = source[key]
  if (value === undefined) {
    return true
  }
  if (!isBoundedString(value)) {
    return false
  }
  target[key] = value
  return true
}

export function parseAgentStatusIpcPayloadCopy(value: unknown): AgentStatusIpcPayload | null {
  const copied = copyJsonRecord(value)
  const payload = normalizeAgentStatusPayload(copied)
  if (
    !copied ||
    !payload ||
    !isBoundedString(copied.paneKey) ||
    (copied.connectionId !== null && !isBoundedString(copied.connectionId)) ||
    !isTimestamp(copied.receivedAt) ||
    !isTimestamp(copied.stateStartedAt) ||
    (copied.evidenceObservedAt !== undefined && !isTimestamp(copied.evidenceObservedAt))
  ) {
    return null
  }
  const parsed: Record<string, unknown> = {
    ...payload,
    paneKey: copied.paneKey,
    connectionId: copied.connectionId,
    receivedAt: copied.receivedAt,
    stateStartedAt: copied.stateStartedAt
  }
  for (const key of [
    'launchToken',
    'terminalHandle',
    'tabId',
    'worktreeId',
    'promptInteractionKey'
  ]) {
    if (!copyOptionalString(copied, parsed, key)) {
      return null
    }
  }
  if (copied.runId !== undefined) {
    if (!isAgentStatusRunId(copied.runId)) {
      return null
    }
    parsed.runId = copied.runId
  }
  if (copied.executionId !== undefined) {
    if (!isAgentStatusExecutionId(copied.executionId)) {
      return null
    }
    parsed.executionId = copied.executionId
  }
  if (copied.providerAlias !== undefined) {
    const providerAlias = parseAgentStatusProviderAlias(copied.providerAlias)
    if (!providerAlias) {
      return null
    }
    parsed.providerAlias = providerAlias
  }
  if (isTimestamp(copied.evidenceObservedAt)) {
    parsed.evidenceObservedAt = copied.evidenceObservedAt
  }
  if (copied.providerSession !== undefined) {
    const providerSession = normalizeAgentProviderSession(copied.providerSession)
    if (!providerSession) {
      return null
    }
    parsed.providerSession = providerSession
  }
  if (copied.orchestration !== undefined) {
    const orchestration = parseOrchestration(copied.orchestration)
    if (!orchestration) {
      return null
    }
    parsed.orchestration = orchestration
  }
  if (copied.observation !== undefined) {
    const observation = parseObservation(copied.observation)
    if (!observation) {
      return null
    }
    parsed.observation = observation
  }
  if (copied.providerSessionOnly === true) {
    parsed.providerSessionOnly = true
  } else if (copied.providerSessionOnly !== undefined && copied.providerSessionOnly !== false) {
    return null
  }
  if (copied.restoredUnconfirmed === true) {
    parsed.restoredUnconfirmed = true
  } else if (copied.restoredUnconfirmed !== undefined && copied.restoredUnconfirmed !== false) {
    return null
  }
  if (copied.structuredHost === 'held' || copied.structuredHost === 'owned') {
    parsed.structuredHost = copied.structuredHost
  } else if (copied.structuredHost !== undefined) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every required and optional field is rebuilt from its canonical parser above.
  return parsed as AgentStatusIpcPayload
}
