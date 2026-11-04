import type { WorkspaceKey } from '../folder-workspaces/folder-workspace-types'
import { isWorkspaceKey } from '../workspace-scope'
import type { CrossStoreWorkspaceLineage } from './lineage-types'

const ORIGINS: readonly unknown[] = ['orchestration', 'cli', 'manual']
const CONFIDENCES: readonly unknown[] = ['explicit', 'inferred']
const OPTIONAL_STRING_FIELDS = [
  'taskId',
  'orchestrationRunId',
  'coordinatorHandle',
  'createdByTerminalHandle'
] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Shape check only; fields a newer build added are allowed and kept. */
export function isCrossStoreWorkspaceLineage(value: unknown): value is CrossStoreWorkspaceLineage {
  if (!isPlainRecord(value) || !isPlainRecord(value.parent) || !isPlainRecord(value.capture)) {
    return false
  }
  const { parent, capture } = value
  return (
    typeof value.childWorkspaceKey === 'string' &&
    isWorkspaceKey(value.childWorkspaceKey) &&
    isNonEmptyString(value.childInstanceId) &&
    isNonEmptyString(parent.installationId) &&
    typeof parent.workspaceKey === 'string' &&
    isWorkspaceKey(parent.workspaceKey) &&
    isNonEmptyString(parent.instanceId) &&
    ORIGINS.includes(value.origin) &&
    typeof capture.source === 'string' &&
    CONFIDENCES.includes(capture.confidence) &&
    Number.isFinite(value.createdAt) &&
    OPTIONAL_STRING_FIELDS.every(
      (field) => value[field] === undefined || typeof value[field] === 'string'
    )
  )
}

/** Drops malformed entries one by one; never the whole map. Undefined when nothing was saved. */
export function normalizeCrossStoreLineageByChildKey(
  value: unknown
): Record<WorkspaceKey, CrossStoreWorkspaceLineage> | undefined {
  if (!isPlainRecord(value)) {
    return undefined
  }
  const kept: Record<WorkspaceKey, CrossStoreWorkspaceLineage> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isCrossStoreWorkspaceLineage(entry) && entry.childWorkspaceKey === key) {
      kept[entry.childWorkspaceKey] = entry
    }
  }
  return kept
}
