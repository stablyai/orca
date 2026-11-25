import type {
  WorkspaceCleanupPolicyComparison,
  WorkspaceCleanupPolicyChange
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { CleanupChangeIntent } from './workspace-cleanup-rule-change-intent'
import type { WorkspaceCleanupRuleChangeRequest } from './workspace-cleanup-rule-change-dialog'
import type {
  WorkspaceCleanupPreviewRow,
  WorkspaceCleanupPreview
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { WorkspaceCleanupKeepSelection } from './workspace-cleanup-keep-selection'
import { cleanupChangeRowKey } from './workspace-cleanup-row-key'
export { cleanupChangeRowKey } from './workspace-cleanup-row-key'

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
  return existing === 0 ? null : added.size > 0 && unmarked === 0 ? 'all' : 'some'
}

export function createCleanupChangeRequest(
  comparison: WorkspaceCleanupPolicyComparison,
  intent: CleanupChangeIntent,
  change: WorkspaceCleanupPolicyChange,
  projectName?: string,
  projectRepoId?: string | null
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
    projectRepoId: projectRepoId ?? undefined,
    rows: cleanupNewRowsFirst(rows, newKeys),
    newKeys,
    currentKeys: new Set(current.map(cleanupChangeRowKey)),
    selection: new WorkspaceCleanupKeepSelection(rows, [], newKeys),
    reviewed: { state: structuredClone(comparison.read.state), change: structuredClone(change) },
    status: null,
    intent
  }
}
