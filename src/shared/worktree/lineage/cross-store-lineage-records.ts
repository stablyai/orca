import { isWorkspaceKey, type WorkspaceKey } from '../../workspace-scope'
import type { CrossStoreWorkspaceLineage } from '../lineage-types'

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

/** Keeps every saved entry as written, readable or not; only a non-object map is discarded. */
export function normalizeCrossStoreLineageByChildKey(
  value: unknown
): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined
}

/** The entries this build can read; the rest stay saved and the child shows standalone. */
export function validCrossStoreLineage(
  saved: Readonly<Record<string, unknown>> | undefined
): Record<WorkspaceKey, CrossStoreWorkspaceLineage> {
  const valid: Record<WorkspaceKey, CrossStoreWorkspaceLineage> = {}
  for (const [key, entry] of Object.entries(saved ?? {})) {
    if (isCrossStoreWorkspaceLineage(entry) && entry.childWorkspaceKey === key) {
      valid[entry.childWorkspaceKey] = entry
    }
  }
  return valid
}

/** Re-keys a saved entry to its child's new key; an unreadable entry moves unchanged. */
export function withCrossStoreChildKey(entry: unknown, childWorkspaceKey: WorkspaceKey): unknown {
  return isPlainRecord(entry) ? { ...entry, childWorkspaceKey } : entry
}
