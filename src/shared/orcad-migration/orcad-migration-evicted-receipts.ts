/**
 * What survives of an import receipt once it ages out of the bounded receipt list: enough to keep
 * answering "committed" for that migration. The rest of a receipt is derived from its manifest.
 */
import { isRecord } from './orcad-migration-manifest-fields'

export const MAX_ORCAD_MIGRATION_EVICTED_RECEIPTS = 4_096

export type OrcadMigrationEvictedReceipt = {
  migrationId: string
  manifestSha256: string
  importedAt: string
}

export function normalizeOrcadMigrationEvictedReceipts(
  value: unknown
): OrcadMigrationEvictedReceipt[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter(
      (entry): entry is OrcadMigrationEvictedReceipt =>
        isRecord(entry) &&
        typeof entry.migrationId === 'string' &&
        entry.migrationId.length > 0 &&
        typeof entry.manifestSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.manifestSha256) &&
        typeof entry.importedAt === 'string' &&
        Number.isFinite(Date.parse(entry.importedAt))
    )
    .map(({ migrationId, manifestSha256, importedAt }) => ({
      migrationId,
      manifestSha256,
      importedAt
    }))
    .slice(-MAX_ORCAD_MIGRATION_EVICTED_RECEIPTS)
}
