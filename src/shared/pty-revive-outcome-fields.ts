import { normalizeAgentProviderSession } from './agent-session-resume'
import { normalizeAgentSessionOwnerBindings } from './agent-session-owner-wire-normalization'
import {
  isRelayPtyPersistenceFieldWithinLimit,
  MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES
} from './pty-persistence-wire-limits'
import type {
  RelayPtyLostEntry,
  RelayPtyReviveDiagnostic,
  RelayPtyRevivedEntry
} from './pty-revive-protocol'
import { isTuiAgent } from './tui-agent-config'
import { terminalSizeAdmissionError } from './terminal-size-limits'
import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MAX_RELAY_PTY_REVIVE_FIELD_BYTES = MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES
const MAX_RELAY_PTY_REVIVE_REPLAY_TAIL_BYTES = 100 * 1024

export function normalizeRelayPtyRevivedEntry(value: unknown): RelayPtyRevivedEntry {
  const entry = requireRelayPtyReviveRecord(value, 'PTY revive revived entry')
  assertExactKeys(
    entry,
    ['id', 'disposition', 'incarnationId', 'paneKey', 'tabId'],
    'PTY revive revived entry'
  )
  if (entry.disposition !== 'replacement-spawned' && entry.disposition !== 'already-managed') {
    throw new Error('PTY revive revived entry disposition is invalid')
  }
  return {
    id: requiredString(entry.id, 'PTY revive revived entry id'),
    disposition: entry.disposition,
    incarnationId: requiredString(entry.incarnationId, 'PTY revive revived entry incarnationId'),
    ...optionalStringField(entry, 'paneKey', 'PTY revive revived entry'),
    ...optionalStringField(entry, 'tabId', 'PTY revive revived entry')
  }
}

export function normalizeRelayPtyLostEntry(value: unknown): RelayPtyLostEntry {
  const entry = requireRelayPtyReviveRecord(value, 'PTY revive lost entry')
  assertExactKeys(
    entry,
    [
      'id',
      'kind',
      'reason',
      'pid',
      'sourceIncarnationId',
      'cols',
      'rows',
      'cwd',
      'paneKey',
      'tabId',
      'attachIdentity',
      'worktreeId',
      'terminalHandle',
      'replayTail',
      'durableLaunch',
      'agentOwners',
      'providerSession',
      'orchestrationTaskId'
    ],
    'PTY revive lost entry'
  )
  if (
    entry.kind !== 'recognized-worker' &&
    entry.kind !== 'ordinary-shell' &&
    entry.kind !== 'unclassified'
  ) {
    throw new Error('PTY revive lost entry kind is invalid')
  }
  if (
    entry.reason !== 'worker-replacement-forbidden' &&
    entry.reason !== 'process-not-running' &&
    entry.reason !== 'pty-runtime-unavailable'
  ) {
    throw new Error('PTY revive lost entry reason is invalid')
  }
  const id = requiredString(entry.id, 'PTY revive lost entry id')
  const sizeError = terminalSizeAdmissionError(entry.cols, entry.rows, 'PTY revive lost entry')
  if (sizeError) {
    throw new Error(sizeError)
  }
  return {
    id,
    kind: entry.kind,
    reason: entry.reason,
    pid: positiveSafeInteger(entry.pid, 'PTY revive lost entry pid'),
    cols: entry.cols as number,
    rows: entry.rows as number,
    cwd: requiredString(entry.cwd, 'PTY revive lost entry cwd'),
    ...optionalStringField(entry, 'sourceIncarnationId', 'PTY revive lost entry'),
    ...optionalStringField(entry, 'paneKey', 'PTY revive lost entry'),
    ...optionalStringField(entry, 'tabId', 'PTY revive lost entry'),
    ...optionalIdentity(entry.attachIdentity),
    ...optionalStringField(entry, 'worktreeId', 'PTY revive lost entry'),
    ...optionalStringField(entry, 'terminalHandle', 'PTY revive lost entry'),
    ...optionalReplayTail(entry.replayTail),
    ...optionalDurableLaunch(entry.durableLaunch),
    ...optionalAgentOwners(entry.agentOwners, id),
    ...optionalProviderSession(entry.providerSession),
    ...optionalStringField(entry, 'orchestrationTaskId', 'PTY revive lost entry')
  }
}

export function normalizeRelayPtyReviveDiagnostic(value: unknown): RelayPtyReviveDiagnostic {
  const diagnostic = requireRelayPtyReviveRecord(value, 'PTY revive diagnostic')
  assertExactKeys(diagnostic, ['code', 'id'], 'PTY revive diagnostic')
  if (
    diagnostic.code !== 'legacy-state' &&
    diagnostic.code !== 'entry-already-pending' &&
    diagnostic.code !== 'entry-invalid' &&
    diagnostic.code !== 'state-budget-reduced'
  ) {
    throw new Error('PTY revive diagnostic code is invalid')
  }
  return {
    code: diagnostic.code,
    ...optionalStringField(diagnostic, 'id', 'PTY revive diagnostic')
  }
}

export function requireRelayPtyReviveRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function optionalIdentity(value: unknown): Pick<RelayPtyLostEntry, 'attachIdentity'> {
  if (value === undefined) {
    return {}
  }
  const identity = requireRelayPtyReviveRecord(value, 'PTY revive attach identity')
  assertExactKeys(identity, ['paneKey', 'tabId'], 'PTY revive attach identity')
  const paneKey = optionalString(identity.paneKey, 'PTY revive attach identity paneKey')
  const tabId = optionalString(identity.tabId, 'PTY revive attach identity tabId')
  return paneKey === undefined && tabId === undefined ? {} : { attachIdentity: { paneKey, tabId } }
}

function optionalReplayTail(value: unknown): Pick<RelayPtyLostEntry, 'replayTail'> {
  if (value === undefined) {
    return {}
  }
  const tail = requireRelayPtyReviveRecord(value, 'PTY revive replay tail')
  assertExactKeys(tail, ['data', 'encoding', 'byteLength', 'truncated'], 'PTY revive replay tail')
  if (tail.encoding !== 'utf8' || typeof tail.truncated !== 'boolean') {
    throw new Error('PTY revive replay tail is invalid')
  }
  const data = requiredString(
    tail.data,
    'PTY revive replay tail data',
    true,
    MAX_RELAY_PTY_REVIVE_REPLAY_TAIL_BYTES
  )
  const byteLength = nonNegativeSafeInteger(tail.byteLength, 'PTY revive replay tail byteLength')
  if (
    byteLength > MAX_RELAY_PTY_REVIVE_REPLAY_TAIL_BYTES ||
    measureUtf8ByteLength(data).byteLength !== byteLength
  ) {
    throw new Error('PTY revive replay tail byteLength is invalid')
  }
  return { replayTail: { data, encoding: 'utf8', byteLength, truncated: tail.truncated } }
}

function optionalDurableLaunch(value: unknown): Pick<RelayPtyLostEntry, 'durableLaunch'> {
  if (value === undefined) {
    return {}
  }
  const launch = requireRelayPtyReviveRecord(value, 'PTY revive durable launch')
  assertExactKeys(
    launch,
    ['startupCommand', 'shellOverride', 'launchAgent', 'startedAt'],
    'PTY revive durable launch'
  )
  const startupCommand = optionalString(
    launch.startupCommand,
    'PTY revive durable launch startupCommand'
  )
  const shellOverride = optionalString(
    launch.shellOverride,
    'PTY revive durable launch shellOverride'
  )
  if (launch.launchAgent !== undefined && !isTuiAgent(launch.launchAgent)) {
    throw new Error('PTY revive durable launch agent is invalid')
  }
  if (
    launch.startedAt !== undefined &&
    (typeof launch.startedAt !== 'number' ||
      !Number.isFinite(launch.startedAt) ||
      launch.startedAt < 0)
  ) {
    throw new Error('PTY revive durable launch startedAt is invalid')
  }
  return {
    durableLaunch: {
      ...(startupCommand === undefined ? {} : { startupCommand }),
      ...(shellOverride === undefined ? {} : { shellOverride }),
      ...(launch.launchAgent === undefined ? {} : { launchAgent: launch.launchAgent }),
      ...(launch.startedAt === undefined ? {} : { startedAt: launch.startedAt as number })
    }
  }
}

function optionalAgentOwners(
  value: unknown,
  entryId: string
): Pick<RelayPtyLostEntry, 'agentOwners'> {
  if (value === undefined) {
    return {}
  }
  return { agentOwners: normalizeAgentSessionOwnerBindings(value, entryId, 'PTY revive') }
}

function optionalProviderSession(value: unknown): Pick<RelayPtyLostEntry, 'providerSession'> {
  if (value === undefined) {
    return {}
  }
  const record = requireRelayPtyReviveRecord(value, 'PTY revive provider session')
  assertExactKeys(record, ['key', 'id', 'transcriptPath'], 'PTY revive provider session')
  const providerSession = normalizeAgentProviderSession(record)
  if (
    !providerSession ||
    !isRelayPtyPersistenceFieldWithinLimit(providerSession.id) ||
    (providerSession.transcriptPath &&
      !isRelayPtyPersistenceFieldWithinLimit(providerSession.transcriptPath))
  ) {
    throw new Error('PTY revive provider session is invalid')
  }
  return { providerSession }
}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false,
  maxBytes = MAX_RELAY_PTY_REVIVE_FIELD_BYTES
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    !isRelayPtyPersistenceFieldWithinLimit(value, maxBytes)
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name)
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  name: string
): Record<string, string> {
  const value = optionalString(record[key], `${name} ${key}`)
  return value === undefined ? {} : { [key]: value }
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${name} contains an unknown field`)
  }
}
