import { describe, expect, it } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'
import {
  compactOrcadMigrationSourceCutoversForAdmission,
  MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS,
  normalizeOrcadMigrationSourceCutovers,
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from './orcad-migration-source-cutover'

function manifest(migrationId = 'migration-1', targetId = 'ssh-prod'): OrcadMigrationManifest {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: { sshTargetId: targetId, sshTargetGeneration: 7, targetLabel: 'Production' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: `${migrationId.length.toString(16)}`.repeat(64).slice(0, 64)
  }
}

function receipt(input: OrcadMigrationManifest): OrcadMigrationImportReceipt {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    source: input.source,
    importedAt: '2026-08-30T12:02:00.000Z',
    repositoryIds: [],
    projectGroupIds: [],
    folderWorkspaceIds: []
  }
}

function base(input: OrcadMigrationManifest) {
  return {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    destinationEnvironmentId: 'environment-1',
    manifest: input,
    startedAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:01:00.000Z'
  }
}

describe('orcad migration source cutover records', () => {
  it('parses each durable phase and exact committed receipt', () => {
    const input = manifest()

    expect(
      parseOrcadMigrationSourceCutover({
        ...base(input),
        destinationName: 'Managed production',
        phase: 'source-fenced'
      })
    ).toMatchObject({ phase: 'source-fenced', destinationName: 'Managed production' })
    expect(
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'destination-staged',
        stagedAt: '2026-08-30T12:01:00.000Z'
      })
    ).toMatchObject({ phase: 'destination-staged' })
    expect(
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'destination-committed',
        receipt: receipt(input)
      })
    ).toMatchObject({ phase: 'destination-committed' })
    expect(
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'source-retired',
        receipt: receipt(input),
        retiredAt: '2026-08-30T12:03:00.000Z'
      })
    ).toMatchObject({ phase: 'source-retired' })
  })

  it('rejects malformed timestamps and a receipt for another catalog', () => {
    const input = manifest()
    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...base(input),
        destinationName: '',
        phase: 'source-fenced'
      })
    ).toThrow('orcad_migration_source_cutover_name_invalid')

    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'destination-staged',
        stagedAt: 'not-a-date'
      })
    ).toThrow('orcad_migration_source_cutover_staged_at_invalid')

    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'destination-committed',
        receipt: receipt(manifest('migration-other'))
      })
    ).toThrow('orcad_migration_source_cutover_receipt_invalid')

    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: 'source-retired',
        receipt: receipt(input),
        retiredAt: 'not-a-date'
      })
    ).toThrow('orcad_migration_source_cutover_retired_at_invalid')
  })

  it('keeps only the newest valid journal per migration and source target', () => {
    const first = manifest('migration-1', 'ssh-shared')
    const newer = manifest('migration-2', 'ssh-shared')
    const distinct = manifest('migration-3', 'ssh-distinct')

    expect(
      normalizeOrcadMigrationSourceCutovers([
        { ...base(first), phase: 'source-fenced' },
        { ...base(newer), phase: 'source-fenced' },
        { ...base(distinct), phase: 'source-fenced' },
        { invalid: true }
      ]).map((entry) => entry.manifest.migrationId)
    ).toEqual(['migration-2', 'migration-3'])
  })

  it('normalizes source journals without Node 20-only array methods', () => {
    const prototype = Array.prototype as unknown as { toReversed?: unknown }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toReversed')
    const input = manifest()
    try {
      Object.defineProperty(prototype, 'toReversed', {
        configurable: true,
        value: undefined,
        writable: true
      })
      expect(
        normalizeOrcadMigrationSourceCutovers([{ ...base(input), phase: 'source-fenced' }])
      ).toEqual([expect.objectContaining({ phase: 'source-fenced' })])
    } finally {
      if (descriptor) {
        Object.defineProperty(prototype, 'toReversed', descriptor)
      } else {
        delete prototype.toReversed
      }
    }
  })

  it('admits another cutover only by compacting the oldest fully retired record', () => {
    const records = Array.from({ length: MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS }, (_, index) => {
      const input = manifest(`migration-${index}`, `ssh-${index}`)
      return parseOrcadMigrationSourceCutover({
        ...base(input),
        phase: index === 1 ? 'source-retired' : 'source-fenced',
        ...(index === 1 ? { receipt: receipt(input), retiredAt: '2026-08-30T12:03:00.000Z' } : {})
      })
    })

    expect(
      compactOrcadMigrationSourceCutoversForAdmission(records).map(
        (entry) => entry.manifest.migrationId
      )
    ).toEqual(['migration-0', 'migration-2', 'migration-3'])
    expect(
      compactOrcadMigrationSourceCutoversForAdmission(
        records.map((record) => ({ ...base(record.manifest), phase: 'source-fenced' }))
      )
    ).toHaveLength(MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS)
    const liveRecords = records.map((record) => ({ ...record, version: 2 as const }))
    expect(compactOrcadMigrationSourceCutoversForAdmission(liveRecords)).toEqual(liveRecords)
    const mixed: OrcadMigrationSourceCutover[] = [...liveRecords]
    const input = mixed[3].manifest
    mixed[3] = parseOrcadMigrationSourceCutover({
      ...base(input),
      phase: 'source-retired',
      receipt: receipt(input),
      retiredAt: '2026-08-30T12:03:00.000Z'
    })
    expect(compactOrcadMigrationSourceCutoversForAdmission(mixed)).toEqual(liveRecords.slice(0, 3))
  })
})
