// The one update of the legacy persistence record, run after every apply: which workspaces'
// terminal rows this partition owns, and the topology revision older builds' save merge defers to.

import { getRepoIdFromWorktreeId } from '../worktree/id'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import {
  paneKeyOf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'

function paneKeys(workspace: WorkspaceLayout): string[] {
  return workspace.tabs.flatMap((tab) =>
    tab.kind === 'terminal'
      ? collectLayoutLeafIdsInOrder(tab.panes.root).map((leafId) => paneKeyOf(tab.entityId, leafId))
      : []
  )
}

/**
 * A workspace that holds a terminal tab owns its rows from then on, even after its last tab
 * closes; a removed workspace no longer does. A repo whose terminal panes changed advances its
 * revision once, as does one `retiredWorktreeIds` names (an exit retirement or legacy tombstone
 * advances it even when the pane was already gone). Panes leaving with a removed workspace, or
 * moving with a renamed one, advance nothing.
 */
export function updateLegacyPersistence(
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel,
  retiredWorktreeIds: readonly string[] = []
): WorkspaceLayoutModel {
  const terminalRowOwners = { ...after.legacy.terminalRowOwners }
  const left = new Map<string, string>()
  const arrived = new Map<string, string>()
  const departed = new Set<string>()
  for (const key of new Set([
    ...Object.keys(before.workspaces),
    ...Object.keys(after.workspaces)
  ])) {
    const old = before.workspaces[key]
    const next = after.workspaces[key]
    if (old === next) {
      continue
    }
    if (!next) {
      delete terminalRowOwners[key]
      paneKeys(old!).forEach((paneKey) => departed.add(paneKey))
      continue
    }
    if (next.tabs.some((tab) => tab.kind === 'terminal')) {
      terminalRowOwners[key] = true
    }
    if (old) {
      paneKeys(old).forEach((paneKey) => left.set(paneKey, old.worktreeId))
    }
    paneKeys(next).forEach((paneKey) => arrived.set(paneKey, next.worktreeId))
  }
  const changed = new Set(retiredWorktreeIds)
  arrived.forEach((worktreeId, paneKey) => {
    if (!left.has(paneKey) && !departed.has(paneKey)) {
      changed.add(worktreeId)
    }
  })
  left.forEach((worktreeId, paneKey) => !arrived.has(paneKey) && changed.add(worktreeId))
  const legacy = { ...after.legacy, terminalRowOwners }
  if (changed.size > 0) {
    const revisions = { ...legacy.topologyRevisionByRepoId }
    for (const repoId of new Set([...changed].map(getRepoIdFromWorktreeId))) {
      revisions[repoId] = (revisions[repoId] ?? 0) + 1
    }
    legacy.topologyRevisionByRepoId = revisions
  }
  return { ...after, legacy }
}
