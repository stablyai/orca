import type {
  OrcadMigrationLocalWslManifestSource,
  OrcadMigrationManifest
} from './orcad-migration-manifest'
import {
  MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
  MAX_ORCAD_MIGRATION_REPOSITORIES,
  boundedStringArray,
  requiredString
} from './orcad-migration-manifest-fields'
import { isOrcadMigrationLocalWslSource } from './orcad-migration-source-kind'

export function parseLocalWslSource(
  value: Record<string, unknown>
): OrcadMigrationLocalWslManifestSource {
  // A non-SSH source naming an SSH target could only be a confused or forged manifest.
  if (value.sshTargetId !== undefined) {
    throw new Error('orcad_migration_manifest_source_invalid')
  }
  const generation = value.generation
  if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
    throw new Error('orcad_migration_manifest_source_generation_invalid')
  }
  return {
    kind: 'local-wsl',
    distro: requiredString(value.distro, 'source.distro'),
    ...(value.distroGuid === undefined
      ? {}
      : { distroGuid: requiredString(value.distroGuid, 'source.distroGuid') }),
    scopeRepoIds: boundedStringArray(
      value.scopeRepoIds,
      MAX_ORCAD_MIGRATION_REPOSITORIES,
      'source.scopeRepoIds_invalid'
    ),
    scopeFolderWorkspaceIds: boundedStringArray(
      value.scopeFolderWorkspaceIds,
      MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
      'source.scopeFolderWorkspaceIds_invalid'
    ),
    generation: Number(generation)
  }
}

/** The catalog a WSL source moves is exactly its declared scope; the host never infers scope. */
export function assertLocalWslScopeMatchesPayload(manifest: OrcadMigrationManifest): void {
  const { source, payload } = manifest
  if (!isOrcadMigrationLocalWslSource(source)) {
    return
  }
  const sameIds = (declared: readonly string[], rows: readonly { id: string }[]): boolean => {
    const ids = new Set(rows.map((row) => row.id))
    // A doubled declared id would let one payload row through unscoped.
    return (
      new Set(declared).size === declared.length &&
      declared.length === ids.size &&
      declared.every((id) => ids.has(id))
    )
  }
  if (
    !sameIds(source.scopeRepoIds, payload.repositories) ||
    !sameIds(source.scopeFolderWorkspaceIds, payload.folderWorkspaces)
  ) {
    throw new Error('orcad_migration_manifest_source_scope_mismatch')
  }
}
