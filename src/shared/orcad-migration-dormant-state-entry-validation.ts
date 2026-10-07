import type {
  OrcadMigrationDormantRetiredNames,
  OrcadMigrationDormantRetirementNamespace,
  OrcadMigrationDormantWorktreeLineage,
  OrcadMigrationDormantWorkspaceLineage,
  OrcadMigrationDormantWorktreeMeta
} from './orcad-migration-manifest'
import type { SparsePreset } from './worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { RetiredNameRegistry } from './worktree/retired-name-registry'
import { parseWorkspaceKey } from './workspace-scope'
import {
  isString,
  optionalNullableString,
  requiredBoolean,
  requiredFinite,
  requiredRecord,
  requiredString,
  requiredStringOrEmpty,
  stringArray
} from './orcad-migration-dormant-value-validation'

const MAX_RETIRED_NAMES = 2_048

export function parseWorktreeMetaEntry(value: unknown): OrcadMigrationDormantWorktreeMeta {
  const record = requiredRecord(value, 'orcad_migration_dormant_worktree_meta_invalid')
  const meta = structuredClone(record.meta)
  if (!isMigratedWorktreeMeta(meta)) {
    throw new Error('orcad_migration_dormant_worktree_meta_value_invalid')
  }
  return {
    sourceKey: requiredString(record.sourceKey, 'orcad_migration_dormant_source_key_invalid'),
    worktreeId: requiredString(record.worktreeId, 'orcad_migration_dormant_worktree_id_invalid'),
    meta
  }
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedWorktreeMeta(value: unknown): value is WorktreeMeta {
  const meta = requiredRecord(value, 'orcad_migration_dormant_worktree_meta_value_invalid')
  requiredStringOrEmpty(
    meta.displayName,
    'orcad_migration_dormant_worktree_meta_display_name_invalid'
  )
  requiredStringOrEmpty(meta.comment, 'orcad_migration_dormant_worktree_meta_comment_invalid')
  requiredBoolean(meta.isArchived, 'orcad_migration_dormant_worktree_meta_archived_invalid')
  requiredBoolean(meta.isUnread, 'orcad_migration_dormant_worktree_meta_unread_invalid')
  requiredBoolean(meta.isPinned, 'orcad_migration_dormant_worktree_meta_pinned_invalid')
  requiredFinite(meta.sortOrder, 'orcad_migration_dormant_worktree_meta_sort_order_invalid')
  requiredFinite(meta.lastActivityAt, 'orcad_migration_dormant_worktree_meta_activity_invalid')
  return true
}

export function parseWorktreeLineageEntry(value: unknown): OrcadMigrationDormantWorktreeLineage {
  const record = requiredRecord(value, 'orcad_migration_dormant_worktree_lineage_invalid')
  const lineage = parseWorktreeLineage(record.lineage)
  return {
    sourceKey: requiredString(record.sourceKey, 'orcad_migration_dormant_source_key_invalid'),
    worktreeId: requiredString(record.worktreeId, 'orcad_migration_dormant_worktree_id_invalid'),
    lineage
  }
}

export function parseWorkspaceLineageEntry(value: unknown): OrcadMigrationDormantWorkspaceLineage {
  const record = requiredRecord(value, 'orcad_migration_dormant_workspace_lineage_invalid')
  const lineage = parseWorkspaceLineage(record.lineage)
  return {
    sourceKey: requiredString(record.sourceKey, 'orcad_migration_dormant_source_key_invalid'),
    childWorkspaceKey: requiredString(
      record.childWorkspaceKey,
      'orcad_migration_dormant_workspace_key_invalid'
    ),
    lineage
  }
}

function parseWorktreeLineage(value: unknown): WorktreeLineage {
  const copy = structuredClone(value)
  if (!isMigratedWorktreeLineage(copy)) {
    throw new Error('orcad_migration_dormant_worktree_lineage_value_invalid')
  }
  return copy
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedWorktreeLineage(value: unknown): value is WorktreeLineage {
  const record = requiredRecord(value, 'orcad_migration_dormant_worktree_lineage_value_invalid')
  requiredString(record.worktreeId, 'orcad_migration_dormant_lineage_worktree_invalid')
  requiredString(record.worktreeInstanceId, 'orcad_migration_dormant_lineage_instance_invalid')
  requiredString(record.parentWorktreeId, 'orcad_migration_dormant_lineage_parent_invalid')
  requiredString(
    record.parentWorktreeInstanceId,
    'orcad_migration_dormant_lineage_parent_instance_invalid'
  )
  parseLineageBase(record)
  return true
}

function parseWorkspaceLineage(value: unknown): WorkspaceLineage {
  const lineage = structuredClone(value)
  if (!isMigratedWorkspaceLineage(lineage)) {
    throw new Error('orcad_migration_dormant_workspace_lineage_value_invalid')
  }
  return {
    ...lineage,
    childInstanceId: lineage.childInstanceId ?? null,
    parentInstanceId: lineage.parentInstanceId ?? null
  }
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedWorkspaceLineage(value: unknown): value is WorkspaceLineage {
  const record = requiredRecord(value, 'orcad_migration_dormant_workspace_lineage_value_invalid')
  const child = requiredString(
    record.childWorkspaceKey,
    'orcad_migration_dormant_lineage_child_invalid'
  )
  const parent = requiredString(
    record.parentWorkspaceKey,
    'orcad_migration_dormant_lineage_parent_invalid'
  )
  if (!parseWorkspaceKey(child) || !parseWorkspaceKey(parent)) {
    throw new Error('orcad_migration_dormant_lineage_workspace_key_invalid')
  }
  parseLineageBase(record)
  optionalNullableString(
    record.childInstanceId,
    'orcad_migration_dormant_lineage_child_instance_invalid'
  )
  optionalNullableString(
    record.parentInstanceId,
    'orcad_migration_dormant_lineage_parent_instance_invalid'
  )
  return true
}

function parseLineageBase(record: Record<string, unknown>): void {
  if (!['orchestration', 'cli', 'manual'].includes(String(record.origin))) {
    throw new Error('orcad_migration_dormant_lineage_origin_invalid')
  }
  const capture = requiredRecord(record.capture, 'orcad_migration_dormant_lineage_capture_invalid')
  if (!['explicit', 'inferred'].includes(String(capture.confidence))) {
    throw new Error('orcad_migration_dormant_lineage_confidence_invalid')
  }
  requiredString(capture.source, 'orcad_migration_dormant_lineage_source_invalid')
  requiredFinite(record.createdAt, 'orcad_migration_dormant_lineage_created_at_invalid')
}

export function parseSparsePreset(value: unknown): SparsePreset {
  const copy = structuredClone(value)
  if (!isMigratedSparsePreset(copy)) {
    throw new Error('orcad_migration_dormant_sparse_preset_invalid')
  }
  return copy
}

/** Throws the specific field error; narrowing only follows these checks. */
function isMigratedSparsePreset(value: unknown): value is SparsePreset {
  const record = requiredRecord(value, 'orcad_migration_dormant_sparse_preset_invalid')
  requiredString(record.id, 'orcad_migration_dormant_sparse_preset_id_invalid')
  requiredString(record.repoId, 'orcad_migration_dormant_sparse_preset_repo_invalid')
  requiredString(record.name, 'orcad_migration_dormant_sparse_preset_name_invalid')
  if (!Array.isArray(record.directories) || !record.directories.every(isString)) {
    throw new Error('orcad_migration_dormant_sparse_preset_directories_invalid')
  }
  requiredFinite(record.createdAt, 'orcad_migration_dormant_sparse_preset_created_at_invalid')
  requiredFinite(record.updatedAt, 'orcad_migration_dormant_sparse_preset_updated_at_invalid')
  return true
}

export function parseRetiredNames(value: unknown): OrcadMigrationDormantRetiredNames {
  const record = requiredRecord(value, 'orcad_migration_dormant_retired_names_invalid')
  return {
    repoId: requiredString(record.repoId, 'orcad_migration_dormant_retired_names_repo_invalid'),
    registry: parseRetiredNameRegistry(record.registry)
  }
}

export function parseRetirementNamespace(value: unknown): OrcadMigrationDormantRetirementNamespace {
  const record = requiredRecord(value, 'orcad_migration_dormant_retirement_namespace_invalid')
  const sourceNamespaceKeys = stringArray(record.sourceNamespaceKeys)
  if (sourceNamespaceKeys.length === 0) {
    throw new Error('orcad_migration_dormant_retirement_namespace_sources_invalid')
  }
  return {
    sourceNamespaceKeys,
    namespaceKey: requiredString(
      record.namespaceKey,
      'orcad_migration_dormant_retirement_namespace_key_invalid'
    ),
    registry: parseRetiredNameRegistry(record.registry)
  }
}

function parseRetiredNameRegistry(value: unknown): RetiredNameRegistry {
  const record = requiredRecord(value, 'orcad_migration_dormant_retired_registry_invalid')
  if (!Number.isInteger(record.exhaustedTiers) || Number(record.exhaustedTiers) < 0) {
    throw new Error('orcad_migration_dormant_retired_registry_watermark_invalid')
  }
  const names = stringArray(record.names, MAX_RETIRED_NAMES)
  return { exhaustedTiers: Number(record.exhaustedTiers), names }
}
