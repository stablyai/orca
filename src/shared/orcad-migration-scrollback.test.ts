import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import {
  assertOrcadMigrationScrollbackReferences,
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  OrcadMigrationSnapshotChunkRequestSchema,
  parseOrcadMigrationSnapshotChunkResult,
  parseOrcadMigrationTerminalScrollbackSnapshots,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationTerminalScrollbackSnapshot
} from './orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from './terminal-scrollback-limits'

const DIGEST = 'a'.repeat(64)

describe('orcad migration scrollback wire validation', () => {
  it('accepts only canonical non-empty bounded base64 chunks', () => {
    const request = chunkRequest('YQ==')
    expect(OrcadMigrationSnapshotChunkRequestSchema.safeParse(request).success).toBe(true)
    for (const bytesBase64 of ['', 'YQ', 'YQ=', 'A===', '***=']) {
      expect(
        OrcadMigrationSnapshotChunkRequestSchema.safeParse({ ...request, bytesBase64 }).success
      ).toBe(false)
    }
  })

  it('requires an acknowledgment for exactly the decoded chunk length', () => {
    const request = chunkRequest(Buffer.from('abc').toString('base64'), 7)
    expect(
      parseOrcadMigrationSnapshotChunkResult(
        {
          migrationId: request.migrationId,
          manifestSha256: request.manifestSha256,
          ref: request.ref,
          acknowledgedOffset: 10
        },
        request
      ).acknowledgedOffset
    ).toBe(10)
    for (const acknowledgedOffset of [7, 9, 11]) {
      expect(() =>
        parseOrcadMigrationSnapshotChunkResult(
          {
            migrationId: request.migrationId,
            manifestSha256: request.manifestSha256,
            ref: request.ref,
            acknowledgedOffset
          },
          request
        )
      ).toThrow('orcad_migration_snapshot_chunk_result_invalid')
    }
  })

  it('requires unique refs and tab/leaf identities', () => {
    const first = descriptor(1)
    expect(() =>
      parseOrcadMigrationTerminalScrollbackSnapshots([first, { ...descriptor(2), ref: first.ref }])
    ).toThrow('orcad_migration_dormant_scrollback_snapshot_ref_duplicate')
    expect(() =>
      parseOrcadMigrationTerminalScrollbackSnapshots([
        first,
        { ...descriptor(2), tabId: first.tabId, leafId: first.leafId }
      ])
    ).toThrow('orcad_migration_dormant_scrollback_snapshot_leaf_duplicate')
  })

  it('enforces descriptor count, per-file, and aggregate limits', () => {
    expect(() =>
      parseOrcadMigrationTerminalScrollbackSnapshots(
        Array.from({ length: MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS + 1 }, (_, index) =>
          descriptor(index + 1)
        )
      )
    ).toThrow('orcad_migration_dormant_scrollback_snapshots_too_many')
    expect(() =>
      parseOrcadMigrationTerminalScrollbackSnapshots([
        { ...descriptor(1), byteLength: TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1 }
      ])
    ).toThrow('orcad_migration_dormant_scrollback_size_invalid')
    expect(() =>
      parseOrcadMigrationTerminalScrollbackSnapshots(
        Array.from({ length: 52 }, (_, index) => ({
          ...descriptor(index + 1),
          byteLength: TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
        }))
      )
    ).toThrow('orcad_migration_dormant_scrollback_snapshots_too_large')
  })

  it('requires one exact descriptor for every published session ref', () => {
    const session = getDefaultWorkspaceSession()
    const first = descriptor(1)
    session.terminalLayoutsByTabId = {
      [first.tabId]: {
        root: { type: 'leaf', leafId: first.leafId },
        activeLeafId: first.leafId,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [first.leafId]: first.ref }
      }
    }
    expect(() => assertOrcadMigrationScrollbackReferences(session, [first])).not.toThrow()
    expect(() => assertOrcadMigrationScrollbackReferences(session, [])).toThrow(
      'orcad_migration_dormant_scrollback_reference_invalid'
    )
    expect(() =>
      assertOrcadMigrationScrollbackReferences(session, [{ ...first, ref: descriptor(2).ref }])
    ).toThrow('orcad_migration_dormant_scrollback_reference_invalid')
    expect(() => assertOrcadMigrationScrollbackReferences(session, [first, descriptor(2)])).toThrow(
      'orcad_migration_dormant_scrollback_reference_invalid'
    )
  })
})

function chunkRequest(bytesBase64: string, offset = 0): OrcadMigrationSnapshotChunkRequest {
  return {
    migrationId: 'migration-1',
    manifestSha256: DIGEST,
    ref: `v1-${'1'.repeat(32)}`,
    offset,
    bytesBase64
  }
}

function descriptor(index: number): OrcadMigrationTerminalScrollbackSnapshot {
  const identity = index.toString(16).padStart(32, '0')
  return {
    tabId: `tab-${index}`,
    leafId: `leaf-${index}`,
    ref: `v1-${identity}`,
    sha256: index.toString(16).padStart(64, '0'),
    byteLength: 1
  }
}
