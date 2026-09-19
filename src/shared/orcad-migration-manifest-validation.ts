import type { FolderWorkspace } from './folder-workspace-types'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationImportReceipt,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from './orcad-migration-manifest'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import {
  assertOrcadMigrationDormantStateReferences,
  parseOrcadMigrationDormantState
} from './orcad-migration-dormant-state-validation'

export const ORCAD_MIGRATION_MANIFEST_VERSION = 1 as const
export type OrcadMigrationManifestVersion = typeof ORCAD_MIGRATION_MANIFEST_VERSION
export const MAX_ORCAD_MIGRATION_MANIFEST_BYTES = 768 * 1024
export const MAX_ORCAD_MIGRATION_REPOSITORIES = 1_024
export const MAX_ORCAD_MIGRATION_PROJECT_GROUPS = 4_096
export const MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES = 16_384
export const MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS = 64

export function parseOrcadMigrationManifest(value: unknown): OrcadMigrationManifest {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_invalid')
  }
  if (value.version !== ORCAD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('orcad_migration_manifest_version_unsupported')
  }
  const migrationId = requiredString(value.migrationId, 'migrationId')
  const createdAt = requiredDate(value.createdAt, 'createdAt')
  const source = parseSource(value.source)
  const payload = parsePayload(value.payload)
  const manifestSha256 = requiredString(value.manifestSha256, 'manifestSha256')
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('orcad_migration_manifest_digest_invalid')
  }
  const manifest: OrcadMigrationManifest = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt,
    source,
    payload,
    ...(value.destinationEnvironmentId === undefined
      ? {}
      : {
          destinationEnvironmentId: requiredString(
            value.destinationEnvironmentId,
            'destinationEnvironmentId'
          )
        }),
    manifestSha256
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength
  if (bytes > MAX_ORCAD_MIGRATION_MANIFEST_BYTES) {
    throw new Error('orcad_migration_manifest_too_large')
  }
  return manifest
}

export function normalizeOrcadMigrationImportReceipts(
  value: unknown
): OrcadMigrationImportReceipt[] {
  if (!Array.isArray(value)) {
    return []
  }
  const receipts: OrcadMigrationImportReceipt[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const receipt = parseReceipt(value[index])
      if (!seen.has(receipt.migrationId)) {
        seen.add(receipt.migrationId)
        receipts.push(receipt)
        if (receipts.length === MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS) {
          break
        }
      }
    } catch {
      // Invalid receipts cannot prove an import and are dropped fail-closed.
    }
  }
  // Keep persisted receipts readable in the documented Node 18 rollback slot.
  return receipts.reduceRight<OrcadMigrationImportReceipt[]>((reversed, receipt) => {
    reversed.push(receipt)
    return reversed
  }, [])
}

function parsePayload(value: unknown): OrcadMigrationCatalogPayload {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_payload_invalid')
  }
  const repositories = boundedArray(
    value.repositories,
    MAX_ORCAD_MIGRATION_REPOSITORIES,
    parseRepository,
    'repositories'
  )
  const projectGroups = boundedArray(
    value.projectGroups,
    MAX_ORCAD_MIGRATION_PROJECT_GROUPS,
    parseProjectGroup,
    'projectGroups'
  )
  const folderWorkspaces = boundedArray(
    value.folderWorkspaces,
    MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
    parseFolderWorkspace,
    'folderWorkspaces'
  )
  assertUniqueIds(repositories, 'repositories')
  assertUniqueIds(projectGroups, 'projectGroups')
  assertUniqueIds(folderWorkspaces, 'folderWorkspaces')
  const dormantState =
    value.dormantState === undefined
      ? undefined
      : parseOrcadMigrationDormantState(value.dormantState)
  if (dormantState) {
    assertOrcadMigrationDormantStateReferences({
      dormantState,
      repositoryIds: new Set(repositories.map((repo) => repo.id)),
      folderWorkspaceIds: new Set(folderWorkspaces.map((workspace) => workspace.id))
    })
  }
  return {
    repositories,
    projectGroups,
    folderWorkspaces,
    ...(dormantState ? { dormantState } : {})
  }
}

function parseSource(value: unknown): OrcadMigrationManifestSource {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_source_invalid')
  }
  const generation = value.sshTargetGeneration
  if (generation !== null && (!Number.isSafeInteger(generation) || Number(generation) < 1)) {
    throw new Error('orcad_migration_manifest_source_generation_invalid')
  }
  return {
    sshTargetId: requiredString(value.sshTargetId, 'source.sshTargetId'),
    sshTargetGeneration: generation === null ? null : Number(generation),
    targetLabel: requiredString(value.targetLabel, 'source.targetLabel')
  }
}

function parseRepository(value: unknown): Repo {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_repository_invalid')
  }
  requiredString(value.id, 'repository.id')
  requiredString(value.path, 'repository.path')
  requiredString(value.displayName, 'repository.displayName')
  requiredString(value.badgeColor, 'repository.badgeColor')
  requiredFiniteNumber(value.addedAt, 'repository.addedAt')
  if (value.kind !== undefined && value.kind !== 'git' && value.kind !== 'folder') {
    throw new Error('orcad_migration_manifest_repository_kind_invalid')
  }
  return structuredClone(value) as Repo
}

function parseProjectGroup(value: unknown): ProjectGroup {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_project_group_invalid')
  }
  requiredString(value.id, 'projectGroup.id')
  requiredString(value.name, 'projectGroup.name')
  requiredFiniteNumber(value.tabOrder, 'projectGroup.tabOrder')
  requiredFiniteNumber(value.createdAt, 'projectGroup.createdAt')
  requiredFiniteNumber(value.updatedAt, 'projectGroup.updatedAt')
  if (value.parentPath !== null && typeof value.parentPath !== 'string') {
    throw new Error('orcad_migration_manifest_project_group_parent_path_invalid')
  }
  if (value.parentGroupId !== null && typeof value.parentGroupId !== 'string') {
    throw new Error('orcad_migration_manifest_project_group_parent_invalid')
  }
  if (typeof value.isCollapsed !== 'boolean') {
    throw new Error('orcad_migration_manifest_project_group_collapsed_invalid')
  }
  if (value.color !== null && typeof value.color !== 'string') {
    throw new Error('orcad_migration_manifest_project_group_color_invalid')
  }
  if (!['manual', 'folder-scan', 'migration'].includes(String(value.createdFrom))) {
    throw new Error('orcad_migration_manifest_project_group_origin_invalid')
  }
  return structuredClone(value) as ProjectGroup
}

function parseFolderWorkspace(value: unknown): FolderWorkspace {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_manifest_folder_workspace_invalid')
  }
  requiredString(value.id, 'folderWorkspace.id')
  requiredString(value.projectGroupId, 'folderWorkspace.projectGroupId')
  requiredString(value.name, 'folderWorkspace.name')
  requiredString(value.folderPath, 'folderWorkspace.folderPath')
  requiredFiniteNumber(value.sortOrder, 'folderWorkspace.sortOrder')
  requiredFiniteNumber(value.lastActivityAt, 'folderWorkspace.lastActivityAt')
  requiredFiniteNumber(value.createdAt, 'folderWorkspace.createdAt')
  requiredFiniteNumber(value.updatedAt, 'folderWorkspace.updatedAt')
  for (const key of ['isArchived', 'isUnread', 'isPinned'] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(`orcad_migration_manifest_folder_workspace_${key}_invalid`)
    }
  }
  return structuredClone(value) as FolderWorkspace
}

function parseReceipt(value: unknown): OrcadMigrationImportReceipt {
  if (!isRecord(value) || value.version !== ORCAD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('orcad_migration_receipt_invalid')
  }
  const manifestSha256 = requiredString(value.manifestSha256, 'receipt.manifestSha256')
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('orcad_migration_receipt_digest_invalid')
  }
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: requiredString(value.migrationId, 'receipt.migrationId'),
    manifestSha256,
    source: parseSource(value.source),
    importedAt: requiredDate(value.importedAt, 'receipt.importedAt'),
    repositoryIds: boundedStringArray(
      value.repositoryIds,
      MAX_ORCAD_MIGRATION_REPOSITORIES,
      'receipt.repositoryIds'
    ),
    projectGroupIds: boundedStringArray(
      value.projectGroupIds,
      MAX_ORCAD_MIGRATION_PROJECT_GROUPS,
      'receipt.projectGroupIds'
    ),
    folderWorkspaceIds: boundedStringArray(
      value.folderWorkspaceIds,
      MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
      'receipt.folderWorkspaceIds'
    )
  }
}

function boundedArray<T>(
  value: unknown,
  maximum: number,
  parse: (entry: unknown) => T,
  label: string
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`orcad_migration_manifest_${label}_invalid`)
  }
  if (value.length > maximum) {
    throw new Error(`orcad_migration_manifest_${label}_too_many`)
  }
  return value.map(parse)
}

function assertUniqueIds(values: { id: string }[], label: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new Error(`orcad_migration_manifest_${label}_duplicate_id`)
    }
    ids.add(value.id)
  }
}

function boundedStringArray(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry)) {
    throw new Error(`${label}_invalid`)
  }
  if (value.length > maximum || new Set(value).size !== value.length) {
    throw new Error(`${label}_invalid`)
  }
  return [...value]
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

function requiredDate(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`${label}_invalid`)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
