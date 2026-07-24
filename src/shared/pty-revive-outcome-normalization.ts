import { measureUtf8ByteLength } from './utf8-byte-limits'
import {
  MAX_RELAY_PTY_REVIVE_ENTRIES,
  MAX_RELAY_PTY_REVIVE_OUTCOME_BYTES,
  RELAY_PTY_REVIVE_OUTCOME_VERSION,
  type RelayPtyReviveOutcomeV1
} from './pty-revive-protocol'
import {
  normalizeRelayPtyLostEntry,
  normalizeRelayPtyReviveDiagnostic,
  normalizeRelayPtyRevivedEntry,
  requireRelayPtyReviveRecord
} from './pty-revive-outcome-fields'

export function normalizeRelayPtyReviveOutcome(value: unknown): RelayPtyReviveOutcomeV1 {
  assertOutcomeByteLimit(value)
  const outcome = requireRelayPtyReviveRecord(value, 'PTY revive outcome')
  assertExactKeys(
    outcome,
    ['outcomeVersion', 'revived', 'lost', 'diagnostics'],
    'PTY revive outcome'
  )
  if (outcome.outcomeVersion !== RELAY_PTY_REVIVE_OUTCOME_VERSION) {
    throw new Error('PTY revive outcome version is unsupported')
  }
  const revived = normalizeArray(
    outcome.revived,
    'PTY revive outcome revived',
    normalizeRelayPtyRevivedEntry
  )
  const lost = normalizeArray(outcome.lost, 'PTY revive outcome lost', normalizeRelayPtyLostEntry)
  if (revived.length + lost.length > MAX_RELAY_PTY_REVIVE_ENTRIES) {
    throw new Error('PTY revive outcome has too many entries')
  }
  if (
    new Set([...revived, ...lost].map((entry) => entry.id)).size !==
    revived.length + lost.length
  ) {
    throw new Error('PTY revive outcome entry ids are duplicated')
  }
  return {
    outcomeVersion: RELAY_PTY_REVIVE_OUTCOME_VERSION,
    revived,
    lost,
    diagnostics: normalizeArray(
      outcome.diagnostics,
      'PTY revive outcome diagnostics',
      normalizeRelayPtyReviveDiagnostic
    )
  }
}

function assertOutcomeByteLimit(value: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('PTY revive outcome must be JSON-compatible')
  }
  if (typeof serialized !== 'string') {
    throw new Error('PTY revive outcome must be JSON-compatible')
  }
  if (
    measureUtf8ByteLength(serialized, { stopAfterBytes: MAX_RELAY_PTY_REVIVE_OUTCOME_BYTES })
      .exceededLimit
  ) {
    throw new Error(`PTY revive outcome exceeds ${MAX_RELAY_PTY_REVIVE_OUTCOME_BYTES} bytes`)
  }
}

function normalizeArray<T>(value: unknown, name: string, normalize: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_RELAY_PTY_REVIVE_ENTRIES) {
    throw new Error(`${name} is invalid`)
  }
  return value.map(normalize)
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
