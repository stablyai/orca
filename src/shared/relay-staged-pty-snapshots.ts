import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { MAX_RELAY_PTY_REVIVE_ENTRIES, type RelayPtyReplayTail } from './pty-revive-protocol'
import { getUtf8ByteLength } from './utf8-byte-limits'

const MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES = 8 * 1024 * 1024

export type RelayStagedPtySnapshot = {
  sourceIncarnationId: string
  replayTail?: RelayPtyReplayTail
}

export type RelayStagedPtySnapshots =
  | { kind: 'missing'; snapshotsByPaneKey: ReadonlyMap<string, RelayStagedPtySnapshot> }
  | { kind: 'legacy'; snapshotsByPaneKey: ReadonlyMap<string, RelayStagedPtySnapshot> }
  | { kind: 'invalid'; snapshotsByPaneKey: ReadonlyMap<string, RelayStagedPtySnapshot> }
  | { kind: 'v2'; snapshotsByPaneKey: ReadonlyMap<string, RelayStagedPtySnapshot> }

const EMPTY_SNAPSHOTS = new Map<string, RelayStagedPtySnapshot>()

export function decodeRelayStagedPtySnapshots(state: string | null): RelayStagedPtySnapshots {
  if (state === null) {
    return { kind: 'missing', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
  }
  if (getUtf8ByteLength(state) > MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES) {
    return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
  }
  try {
    assertJsonTextStructureWithinLimits(state, { structuralTokens: 131_072, nestingDepth: 8 })
    const value = JSON.parse(state) as unknown
    if (Array.isArray(value)) {
      return { kind: 'legacy', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
    }
    if (!value || typeof value !== 'object') {
      return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
    }
    const envelope = value as { schemaVersion?: unknown; entries?: unknown }
    if (envelope.schemaVersion !== 2 || !Array.isArray(envelope.entries)) {
      return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
    }
    if (envelope.entries.length > MAX_RELAY_PTY_REVIVE_ENTRIES) {
      return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
    }
    const snapshotsByPaneKey = new Map<string, RelayStagedPtySnapshot>()
    for (const entry of envelope.entries) {
      if (!entry || typeof entry !== 'object') {
        return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
      }
      const candidate = entry as {
        paneKey?: unknown
        sourceIncarnationId?: unknown
        replayTail?: unknown
      }
      if (
        typeof candidate.paneKey !== 'string' ||
        typeof candidate.sourceIncarnationId !== 'string'
      ) {
        return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
      }
      if (snapshotsByPaneKey.has(candidate.paneKey)) {
        return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
      }
      const replayTail = decodeReplayTail(candidate.replayTail)
      if (candidate.replayTail !== undefined && replayTail === null) {
        return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
      }
      snapshotsByPaneKey.set(candidate.paneKey, {
        sourceIncarnationId: candidate.sourceIncarnationId,
        ...(replayTail ? { replayTail } : {})
      })
    }
    return { kind: 'v2', snapshotsByPaneKey }
  } catch {
    return { kind: 'invalid', snapshotsByPaneKey: EMPTY_SNAPSHOTS }
  }
}

function decodeReplayTail(value: unknown): RelayPtyReplayTail | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const tail = value as Partial<RelayPtyReplayTail>
  if (
    typeof tail.data !== 'string' ||
    tail.encoding !== 'utf8' ||
    typeof tail.byteLength !== 'number' ||
    !Number.isSafeInteger(tail.byteLength) ||
    tail.byteLength < 0 ||
    typeof tail.truncated !== 'boolean' ||
    getUtf8ByteLength(tail.data) !== tail.byteLength
  ) {
    return null
  }
  return {
    data: tail.data,
    encoding: 'utf8',
    byteLength: tail.byteLength,
    truncated: tail.truncated
  }
}
