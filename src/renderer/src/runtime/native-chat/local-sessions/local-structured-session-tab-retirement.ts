import type { WorktreeRuntimeOwnerState } from '../../../lib/workspace/ownership/worktree-runtime-owner-state'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { WebSessionTabsSyncState } from '../../web-session-tabs-sync/state'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../store/workspaces/catalog/workspace-record-fields'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export type StructuredSessionTabPublicationVersion = {
  publicationEpoch: string
  snapshotVersion: number
  /** The stream frame last applied, so a later one differing only in version skips reconciliation. */
  applied?: RuntimeMobileSessionTabsResult
}

type WorkspaceCatalog = Pick<
  WorktreeRuntimeOwnerState,
  'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'
>
let catalogCensus: { inputs: unknown[]; ids: Set<string> } | null = null

// Chat frames arrive far more often than the workspace catalog changes, so its census is rebuilt only on catalog change.
function catalogWorkspaceIds(state: WorkspaceCatalog): Set<string> {
  const worktreesByRepo = selectWorktreesByRepo(state)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(state)
  const folderWorkspaces = selectFolderWorkspaces(state)
  const inputs = [worktreesByRepo, detectedWorktreesByRepo, folderWorkspaces]
  if (catalogCensus?.inputs.every((input, index) => input === inputs[index])) {
    return catalogCensus.ids
  }
  const ids = new Set<string>([FLOATING_TERMINAL_WORKTREE_ID])
  for (const worktrees of Object.values(worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      ids.add(worktree.id)
    }
  }
  for (const detected of Object.values(detectedWorktreesByRepo ?? {})) {
    for (const worktree of detected.worktrees) {
      ids.add(worktree.id)
    }
  }
  for (const workspace of folderWorkspaces ?? []) {
    ids.add(folderWorkspaceKey(workspace.id))
  }
  catalogCensus = { inputs, ids }
  return ids
}

export function isKnownStructuredSessionWorktree(
  state: WebSessionTabsSyncState & WorktreeRuntimeOwnerState
): (worktreeId: string) => boolean {
  const catalog = catalogWorkspaceIds(state)
  return (worktreeId) =>
    catalog.has(worktreeId) || Object.hasOwn(state.unifiedTabsByWorktree, worktreeId)
}
