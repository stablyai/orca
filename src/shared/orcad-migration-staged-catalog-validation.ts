import type { OrcadMigrationStagedCatalog } from './orcad-migration-manifest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from './orcad-migration-manifest-validation'

export const MAX_ORCAD_MIGRATION_STAGED_CATALOGS = 4

export function normalizeOrcadMigrationStagedCatalogs(
  value: unknown
): OrcadMigrationStagedCatalog[] {
  if (!Array.isArray(value)) {
    return []
  }
  const staged: OrcadMigrationStagedCatalog[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const entry = parseStagedCatalog(value[index])
      if (!seen.has(entry.manifest.migrationId)) {
        seen.add(entry.manifest.migrationId)
        staged.push(entry)
        if (staged.length === MAX_ORCAD_MIGRATION_STAGED_CATALOGS) {
          break
        }
      }
    } catch {
      // Invalid staging cannot fence a source cutover and is dropped fail-closed.
    }
  }
  // Keep the migration journal runnable in the documented Node 18 rollback slot.
  return staged.reduceRight<OrcadMigrationStagedCatalog[]>((reversed, entry) => {
    reversed.push(entry)
    return reversed
  }, [])
}

function parseStagedCatalog(value: unknown): OrcadMigrationStagedCatalog {
  if (!isRecord(value) || value.version !== ORCAD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('orcad_migration_staged_catalog_invalid')
  }
  const stagedAt = typeof value.stagedAt === 'string' ? value.stagedAt : ''
  if (!Number.isFinite(Date.parse(stagedAt))) {
    throw new Error('orcad_migration_staged_at_invalid')
  }
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    manifest: parseOrcadMigrationManifest(value.manifest),
    stagedAt
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
