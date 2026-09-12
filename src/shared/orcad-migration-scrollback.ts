import { z } from 'zod'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from './terminal-scrollback-limits'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  assertUnique,
  boundedArray,
  requiredRecord,
  requiredString
} from './orcad-migration-dormant-value-validation'

export const MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS = 512
export const MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES = 256 * 1024 * 1024
export const ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES = 128 * 1024

const Identity = z.string().min(1).max(256)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const SnapshotRef = z.string().regex(/^v1-[a-f0-9]{32}$/)
const CanonicalBase64Chunk = z
  .string()
  .max(Math.ceil(ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES / 3) * 4)
  .refine((value) => {
    try {
      return value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value
    } catch {
      return false
    }
  })

export type OrcadMigrationTerminalScrollbackSnapshot = {
  tabId: string
  leafId: string
  ref: string
  sha256: string
  byteLength: number
}

export const OrcadMigrationSnapshotChunkRequestSchema = z
  .object({
    migrationId: Identity,
    manifestSha256: Digest,
    ref: SnapshotRef,
    offset: z.number().int().nonnegative().max(MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES),
    bytesBase64: CanonicalBase64Chunk
  })
  .strict()

export type OrcadMigrationSnapshotChunkRequest = z.infer<
  typeof OrcadMigrationSnapshotChunkRequestSchema
>

export type OrcadMigrationSnapshotChunkResult = {
  migrationId: string
  manifestSha256: string
  ref: string
  acknowledgedOffset: number
}

export type OrcadMigrationSnapshotUploadState = OrcadMigrationTerminalScrollbackSnapshot & {
  receivedBytes: number
}

export function parseOrcadMigrationSnapshotUploadStates(
  value: unknown,
  snapshots: readonly OrcadMigrationTerminalScrollbackSnapshot[]
): OrcadMigrationSnapshotUploadState[] | undefined {
  if (snapshots.length === 0) {
    return undefined
  }
  if (!Array.isArray(value) || value.length !== snapshots.length) {
    throw new Error('orcad_migration_snapshot_transfer_unsupported')
  }
  return snapshots.map((expected, index) => {
    const record = requiredRecord(value[index], 'orcad_migration_snapshot_state_invalid')
    if (
      record.tabId !== expected.tabId ||
      record.leafId !== expected.leafId ||
      record.ref !== expected.ref ||
      record.sha256 !== expected.sha256 ||
      record.byteLength !== expected.byteLength ||
      !Number.isSafeInteger(record.receivedBytes) ||
      Number(record.receivedBytes) < 0 ||
      Number(record.receivedBytes) > expected.byteLength
    ) {
      throw new Error('orcad_migration_snapshot_state_invalid')
    }
    return { ...expected, receivedBytes: Number(record.receivedBytes) }
  })
}

export function parseOrcadMigrationSnapshotChunkResult(
  value: unknown,
  request: OrcadMigrationSnapshotChunkRequest
): OrcadMigrationSnapshotChunkResult {
  const record = requiredRecord(value, 'orcad_migration_snapshot_chunk_result_invalid')
  const acknowledgedOffset =
    request.offset + decodeOrcadMigrationSnapshotChunk(request.bytesBase64).length
  if (
    record.migrationId !== request.migrationId ||
    record.manifestSha256 !== request.manifestSha256 ||
    record.ref !== request.ref ||
    !Number.isSafeInteger(record.acknowledgedOffset) ||
    Number(record.acknowledgedOffset) !== acknowledgedOffset
  ) {
    throw new Error('orcad_migration_snapshot_chunk_result_invalid')
  }
  return {
    migrationId: request.migrationId,
    manifestSha256: request.manifestSha256,
    ref: request.ref,
    acknowledgedOffset
  }
}

export function parseOrcadMigrationTerminalScrollbackSnapshots(
  value: unknown
): OrcadMigrationTerminalScrollbackSnapshot[] {
  const snapshots = boundedArray(
    value,
    parseSnapshot,
    'scrollback_snapshots',
    MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS
  )
  assertUnique(snapshots, (entry) => entry.ref, 'scrollback_snapshot_ref')
  assertUnique(snapshots, (entry) => `${entry.tabId}\0${entry.leafId}`, 'scrollback_snapshot_leaf')
  if (
    snapshots.reduce((total, entry) => total + entry.byteLength, 0) >
    MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
  ) {
    throw new Error('orcad_migration_dormant_scrollback_snapshots_too_large')
  }
  return snapshots
}

export function assertOrcadMigrationScrollbackReferences(
  session: WorkspaceSessionState | undefined,
  snapshots: readonly OrcadMigrationTerminalScrollbackSnapshot[]
): void {
  const expected = new Map(snapshots.map((entry) => [`${entry.tabId}\0${entry.leafId}`, entry]))
  let referenceCount = 0
  for (const [tabId, layout] of Object.entries(session?.terminalLayoutsByTabId ?? {})) {
    for (const [leafId, ref] of Object.entries(layout.scrollbackRefsByLeafId ?? {})) {
      const descriptor = expected.get(`${tabId}\0${leafId}`)
      if (!descriptor || descriptor.ref !== ref) {
        throw new Error('orcad_migration_dormant_scrollback_reference_invalid')
      }
      referenceCount += 1
    }
  }
  if (referenceCount !== snapshots.length) {
    throw new Error('orcad_migration_dormant_scrollback_reference_invalid')
  }
}

export function decodeOrcadMigrationSnapshotChunk(bytesBase64: string): Buffer {
  const bytes = Buffer.from(bytesBase64, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES ||
    bytes.toString('base64') !== bytesBase64
  ) {
    throw new Error('orcad_migration_snapshot_chunk_invalid')
  }
  return bytes
}

function parseSnapshot(value: unknown): OrcadMigrationTerminalScrollbackSnapshot {
  const record = requiredRecord(value, 'orcad_migration_dormant_scrollback_snapshot_invalid')
  const ref = requiredString(record.ref, 'orcad_migration_dormant_scrollback_ref_invalid')
  const sha256 = requiredString(record.sha256, 'orcad_migration_dormant_scrollback_digest_invalid')
  if (!SnapshotRef.safeParse(ref).success || !Digest.safeParse(sha256).success) {
    throw new Error('orcad_migration_dormant_scrollback_identity_invalid')
  }
  if (
    !Number.isSafeInteger(record.byteLength) ||
    Number(record.byteLength) < 1 ||
    Number(record.byteLength) > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
  ) {
    throw new Error('orcad_migration_dormant_scrollback_size_invalid')
  }
  return {
    tabId: requiredString(record.tabId, 'orcad_migration_dormant_scrollback_tab_invalid'),
    leafId: requiredString(record.leafId, 'orcad_migration_dormant_scrollback_leaf_invalid'),
    ref,
    sha256,
    byteLength: Number(record.byteLength)
  }
}
