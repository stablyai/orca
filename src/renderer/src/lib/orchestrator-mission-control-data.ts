import type { WorktreeLineage } from '../../../shared/types'
import type { OrchestrationActivity, OrchestrationRunDag } from '../../../shared/runtime-types'

// Why (#6/#7): the activity map and DAG map are keyed by the coordinator's
// paneKey (`${tabId}:${leafId}`). A director's coordinator pane lives in one of
// the director worktree's tabs, so match an entry whose paneKey's tabId is one of
// the director's tab ids — the same lookup the sidebar dot uses.
function findByPaneKeyTabId<T>(byPaneKey: Record<string, T>, tabIds: readonly string[]): T | null {
  for (const [paneKey, value] of Object.entries(byPaneKey)) {
    const colon = paneKey.indexOf(':')
    if (colon <= 0 || !tabIds.includes(paneKey.slice(0, colon))) {
      continue
    }
    return value
  }
  return null
}

export function selectRunDagForTabs(
  tabIds: readonly string[],
  orchestrationRunDagByPaneKey: Record<string, OrchestrationRunDag>
): OrchestrationRunDag | null {
  return findByPaneKeyTabId(orchestrationRunDagByPaneKey, tabIds)
}

export function selectOrchestrationActivityForTabs(
  tabIds: readonly string[],
  orchestrationActivityByPaneKey: Record<string, OrchestrationActivity>
): OrchestrationActivity | null {
  return findByPaneKeyTabId(orchestrationActivityByPaneKey, tabIds)
}

// Why: a director's workers are the worktrees whose lineage parent is the
// director's own worktree. `orca worktree create`, run by the director inside
// its checkout, captures that checkout as the parent (cwd-context, or
// orchestration-context when dispatched) — so the renderer can list a director's
// workers from the synced `worktreeLineageById` map with no backend changes.
// Filtered to still-live worktrees so torn-down workers drop off; oldest first.
export function selectSpawnedWorktreeIds(
  directorWorktreeId: string,
  worktreeLineageById: Record<string, WorktreeLineage>,
  isLive: (worktreeId: string) => boolean
): string[] {
  return Object.values(worktreeLineageById)
    .filter(
      (lineage) => lineage.parentWorktreeId === directorWorktreeId && isLive(lineage.worktreeId)
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((lineage) => lineage.worktreeId)
}
