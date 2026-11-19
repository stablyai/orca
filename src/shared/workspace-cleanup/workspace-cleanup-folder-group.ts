import type { WorkspaceCleanupEvaluation } from './workspace-cleanup-evaluation'

/**
 * A folder workspace is one unit of work: its attached checkouts (one per repo) clean up only when
 * every member is removable. Any member that must keep vetoes its siblings, so cleanup never pulls
 * one repo's checkout out from under another repo still being worked on (#44715).
 */
export function applyFolderWorkspaceCleanupGroupVeto(
  rows: readonly {
    readonly folderParentKey?: string
    readonly evaluation: WorkspaceCleanupEvaluation
  }[]
): WorkspaceCleanupEvaluation[] {
  const vetoedGroups = new Set<string>()
  for (const row of rows) {
    if (row.folderParentKey !== undefined && row.evaluation.action === 'keep') {
      vetoedGroups.add(row.folderParentKey)
    }
  }
  if (vetoedGroups.size === 0) {
    return rows.map((row) => row.evaluation)
  }
  return rows.map((row) =>
    row.folderParentKey !== undefined &&
    vetoedGroups.has(row.folderParentKey) &&
    row.evaluation.action !== 'keep'
      ? { action: 'keep', cause: 'folder-mate-in-use' }
      : row.evaluation
  )
}
