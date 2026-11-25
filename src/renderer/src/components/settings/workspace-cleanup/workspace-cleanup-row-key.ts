import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

export function cleanupChangeRowKey(row: WorkspaceCleanupPreviewRow): string {
  return `${row.executionHostId ?? 'local'}:${row.worktreeId}:${row.instanceId ?? ''}`
}
