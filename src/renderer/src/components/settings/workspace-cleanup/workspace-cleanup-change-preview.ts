import type { WorkspaceCleanupPolicyComparison } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { CleanupChangeIntent } from './workspace-cleanup-rule-change-intent'
import type { WorkspaceCleanupRuleChangeRequest } from './workspace-cleanup-rule-change-dialog'
import type {
  WorkspaceCleanupPreviewRow,
  WorkspaceCleanupPreview
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

export function cleanupChangeRowKey(row: WorkspaceCleanupPreviewRow): string {
  return `${row.executionHostId ?? 'local'}:${row.worktreeId}:${row.instanceId ?? ''}`
}
export function toggleCleanupKeep<
  T extends {
    kept: ReadonlySet<string>
    keepRefs?: ReadonlyMap<string, WorkspaceCleanupPreviewRow>
  }
>(value: T | null, row: WorkspaceCleanupPreviewRow): T | null {
  if (!value) {
    return value
  }
  const kept = new Set(value.kept),
    keepRefs = new Map(value.keepRefs)
  const key = cleanupChangeRowKey(row)
  if (kept.delete(key)) {
    keepRefs.delete(key)
  } else {
    kept.add(key)
    keepRefs.set(key, row)
  }
  return { ...value, kept, keepRefs }
}
function strength(row: WorkspaceCleanupPreviewRow): number {
  return row.evaluation.action === 'delete' ? 2 : row.evaluation.action === 'archive' ? 1 : 0
}
export function cleanupDestructiveRows(
  preview: WorkspaceCleanupPreview
): WorkspaceCleanupPreviewRow[] {
  return preview.rows.filter((row) => strength(row) > 0)
}
export function cleanupAddedRows(
  next: readonly WorkspaceCleanupPreviewRow[],
  current: readonly WorkspaceCleanupPreviewRow[]
): Set<string> {
  const before = new Map(current.map((row) => [cleanupChangeRowKey(row), strength(row)]))
  return new Set(
    next
      .filter((row) => strength(row) > (before.get(cleanupChangeRowKey(row)) ?? 0))
      .map(cleanupChangeRowKey)
  )
}
export function cleanupNewRowsFirst(
  rows: readonly WorkspaceCleanupPreviewRow[],
  keys: ReadonlySet<string>
): WorkspaceCleanupPreviewRow[] {
  const added: WorkspaceCleanupPreviewRow[] = [],
    existing: WorkspaceCleanupPreviewRow[] = []
  for (const row of rows) {
    ;(keys.has(cleanupChangeRowKey(row)) ? added : existing).push(row)
  }
  return [...added, ...existing]
}
export function cleanupExistingRuleNotice(
  rows: readonly WorkspaceCleanupPreviewRow[],
  added: ReadonlySet<string>,
  current: ReadonlySet<string>
): 'all' | 'some' | null {
  if (!added.size || added.size === rows.length) {
    return null
  }
  let existing = 0,
    unmarked = 0
  for (const row of rows) {
    const key = cleanupChangeRowKey(row)
    if (current.has(key)) {
      existing++
    }
    if (!added.has(key) && !current.has(key)) {
      unmarked++
    }
  }
  return unmarked === 0 ? 'all' : existing > 0 ? 'some' : null
}

export function createCleanupChangeRequest(
  comparison: WorkspaceCleanupPolicyComparison,
  intent: CleanupChangeIntent,
  projectName?: string
): (WorkspaceCleanupRuleChangeRequest & { intent: CleanupChangeIntent }) | null {
  const rows = cleanupDestructiveRows(comparison.next)
  const current = cleanupDestructiveRows(comparison.current)
  const delta = cleanupAddedRows(rows, current)
  if (!delta.size && intent.kind !== 'disable-ignored-files') {
    return null
  }
  const newKeys = delta.size === rows.length ? new Set<string>() : delta
  return {
    kind: intent.kind,
    setting: intent.setting,
    projectName,
    rows: cleanupNewRowsFirst(rows, newKeys),
    newKeys,
    currentKeys: new Set(current.map(cleanupChangeRowKey)),
    kept: new Set(),
    keepRefs: new Map(),
    status: null,
    intent
  }
}
