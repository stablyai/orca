import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'

export type StructuredSessionTabPublicationVersion = {
  publicationEpoch: string
  snapshotVersion: number
}

export function knownStructuredSessionWorktreeIds(
  state: WebSessionTabsSyncState & WorktreeRuntimeOwnerState
): Set<string> {
  const ids = new Set<string>(Object.keys(state.unifiedTabsByWorktree))
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      ids.add(worktree.id)
    }
  }
  for (const detected of Object.values(state.detectedWorktreesByRepo ?? {})) {
    for (const worktree of detected.worktrees) {
      ids.add(worktree.id)
    }
  }
  for (const workspace of state.folderWorkspaces ?? []) {
    ids.add(folderWorkspaceKey(workspace.id))
  }
  return ids
}
