import {
  normalizeOrcadMigrationImportReceipts,
  type OrcadMigrationCatalogAbortResult,
  type OrcadMigrationCatalogState,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'
import { parseOrcadMigrationSnapshotUploadStates } from './orcad-migration-scrollback'

export function parseOrcadMigrationCatalogState(
  value: unknown,
  manifest: OrcadMigrationManifest
): OrcadMigrationCatalogState {
  const record = requireRecord(value)
  if (
    record.migrationId !== manifest.migrationId ||
    record.manifestSha256 !== manifest.manifestSha256
  ) {
    throw new Error('orcad_migration_catalog_state_identity_mismatch')
  }
  if (record.state === 'absent') {
    return migrationIdentity('absent', manifest)
  }
  if (record.state === 'staged') {
    const stagedAt = requireDate(record.stagedAt)
    const snapshotUploads = parseOrcadMigrationSnapshotUploadStates(
      record.snapshotUploads,
      manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    )
    return {
      ...migrationIdentity('staged', manifest),
      stagedAt,
      ...(snapshotUploads ? { snapshotUploads } : {})
    }
  }
  if (record.state === 'committed') {
    const receipt = normalizeOrcadMigrationImportReceipts([record.receipt])[0]
    if (
      !receipt ||
      receipt.migrationId !== manifest.migrationId ||
      receipt.manifestSha256 !== manifest.manifestSha256
    ) {
      throw new Error('orcad_migration_catalog_state_receipt_invalid')
    }
    return { ...migrationIdentity('committed', manifest), receipt }
  }
  throw new Error('orcad_migration_catalog_state_invalid')
}

export function parseOrcadMigrationCatalogAbortResult(
  value: unknown,
  manifest: OrcadMigrationManifest
): OrcadMigrationCatalogAbortResult {
  const state = parseOrcadMigrationCatalogState(value, manifest)
  const record = requireRecord(value)
  if (typeof record.aborted !== 'boolean') {
    throw new Error('orcad_migration_catalog_abort_result_invalid')
  }
  if (
    record.durableAbsent !== undefined &&
    (record.durableAbsent !== true || state.state !== 'absent')
  ) {
    throw new Error('orcad_migration_catalog_abort_durability_invalid')
  }
  return {
    ...state,
    aborted: record.aborted,
    ...(record.durableAbsent === true ? { durableAbsent: true as const } : {})
  }
}

function migrationIdentity<TState extends OrcadMigrationCatalogState['state']>(
  state: TState,
  manifest: OrcadMigrationManifest
): Extract<OrcadMigrationCatalogState, { state: TState }> {
  return {
    state,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  } as Extract<OrcadMigrationCatalogState, { state: TState }>
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('orcad_migration_catalog_state_invalid')
  }
  return value as Record<string, unknown>
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('orcad_migration_catalog_state_staged_at_invalid')
  }
  return value
}
