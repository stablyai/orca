import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
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

export function removeStructuredSessionTabsForVersions<
  State extends WebSessionTabsSyncState & WorktreeRuntimeOwnerState
>(
  state: State,
  versions: Iterable<readonly [string, StructuredSessionTabPublicationVersion]>,
  owner: string,
  now: number
): State {
  let next = state
  for (const [worktree, version] of versions) {
    const patch = applyWebSessionTabsSnapshot(
      next,
      {
        worktree,
        publicationEpoch: version.publicationEpoch,
        snapshotVersion: version.snapshotVersion + 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabGroups: [],
        tabs: []
      },
      owner,
      now,
      {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      }
    )
    next = patch === next ? next : ({ ...next, ...patch } as State)
  }
  return next
}
