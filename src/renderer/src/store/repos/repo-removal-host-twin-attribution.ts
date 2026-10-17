import type { AppState } from '../types'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  belongsToRemovedHost,
  ptyHostEvidence,
  terminalTabBelongsToHost,
  terminalTabPtyEvidence,
  type HostEvidence
} from './host-twin-terminal-evidence'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'

/**
 * State under a worktree id that a surviving host also publishes, attributed to the removed host.
 * Anything without host evidence stays: it may be the survivor's.
 */
export type RemovedHostTwinState = {
  terminalTabIds: Set<string>
  fileIds: Set<string>
  browserTabIds: Set<string>
  /** Unified tab ids of the removed host's chats, simulators and other non-file surfaces. */
  otherTabIds: Set<string>
  /** Their conversation ids, which key the chats' drafts. */
  conversationIds: Set<string>
  /** Live removed-host panes inside tabs that stay because another host's pane shares them. */
  mixedTabPtyIds: Set<string>
}

/** Runtime files always record their environment, so an unmarked one is local/SSH. */
function openFileHostEvidence(
  file: Parameters<typeof hasOpenFileExecutionHostEvidence>[0]
): HostEvidence {
  return hasOpenFileExecutionHostEvidence(file) ? getOpenFileExecutionHostId(file) : 'non-runtime'
}

/** A browser page's host: null is explicitly this client, absent is unknown. */
function pageHostEvidence(page: {
  browserRuntimeEnvironmentId?: string | null
}): HostEvidence {
  if (page.browserRuntimeEnvironmentId === null) {
    return 'non-runtime'
  }
  return page.browserRuntimeEnvironmentId
    ? toRuntimeExecutionHostId(page.browserRuntimeEnvironmentId)
    : null
}

/**
 * Maps a removed copy's transport aliases to its host id. Why: an SSH copy reached through a
 * paired runtime stamps its tabs, launches and snapshots with that runtime's id.
 */
export function removedHostCanonicalizer(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string,
  removedHostId: ExecutionHostId,
  survivors: readonly ExecutionHostId[]
): (evidence: HostEvidence) => HostEvidence {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const removedRow = [
    ...(state.worktreesByRepo[repoId] ?? []),
    ...(state.detectedWorktreesByRepo[repoId]?.worktrees ?? [])
  ].find((row) => row.id === worktreeId && row.hostId === removedHostId)
  return (evidence) =>
    evidence &&
    evidence !== 'non-runtime' &&
    evidence !== 'foreign' &&
    !survivors.includes(evidence) &&
    isExecutionHostAliasForWorktree(evidence, removedRow ?? { hostId: removedHostId })
      ? removedHostId
      : evidence
}

export function collectRemovedHostTwinState(
  state: AppState,
  twinWorktreeIds: ReadonlySet<string>,
  removedHostId: ExecutionHostId,
  survivingHostIdsByWorktreeId: ReadonlyMap<string, readonly ExecutionHostId[]>
): RemovedHostTwinState {
  const removed: RemovedHostTwinState = {
    terminalTabIds: new Set(),
    fileIds: new Set(),
    browserTabIds: new Set(),
    otherTabIds: new Set(),
    conversationIds: new Set(),
    mixedTabPtyIds: new Set()
  }
  for (const worktreeId of twinWorktreeIds) {
    const survivors = survivingHostIdsByWorktreeId.get(worktreeId) ?? []
    const canonical = removedHostCanonicalizer(state, worktreeId, removedHostId, survivors)
    const owns = (evidence: HostEvidence): boolean =>
      belongsToRemovedHost(canonical(evidence), removedHostId, survivors)
    const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const stampedHostByEntityId = new Map(
      unifiedTabs.flatMap((tab) =>
        tab.executionHostId ? [[tab.entityId, canonical(tab.executionHostId)] as const] : []
      )
    )
    const ownsTerminal = (tabId: string, rowPtyId: string | null): boolean =>
      terminalTabBelongsToHost(
        stampedHostByEntityId.get(tabId),
        terminalTabPtyEvidence(state, tabId, rowPtyId),
        removedHostId,
        survivors,
        canonical
      )
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      if (ownsTerminal(tab.id, tab.ptyId)) {
        removed.terminalTabIds.add(tab.id)
        continue
      }
      for (const ptyId of state.ptyIdsByTabId[tab.id] ?? []) {
        if (owns(ptyHostEvidence(ptyId))) {
          removed.mixedTabPtyIds.add(ptyId)
        }
      }
    }
    for (const file of state.openFiles) {
      if (file.worktreeId !== worktreeId) {
        continue
      }
      // Why file first: its own route names the host; a tab stamp can come from the focused twin.
      const evidence = hasOpenFileExecutionHostEvidence(file)
        ? openFileHostEvidence(file)
        : (stampedHostByEntityId.get(file.id) ?? 'non-runtime')
      if (owns(evidence)) {
        removed.fileIds.add(file.id)
      }
    }
    // Why: a browser restored or opened in an inactive twin has no tab stamp, only its pages' host.
    for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
      if (stampedHostByEntityId.has(workspace.id)) {
        continue
      }
      const pages = state.browserPagesByWorkspace[workspace.id] ?? []
      if (pages.length > 0 && pages.map(pageHostEvidence).every(owns)) {
        removed.browserTabIds.add(workspace.id)
      }
    }
    for (const tab of unifiedTabs) {
      if (!tab.executionHostId || canonical(tab.executionHostId) !== removedHostId) {
        continue
      }
      if (tab.contentType === 'terminal') {
        // Why: a hydrated terminal can exist only as a unified tab, with no legacy row above.
        if (ownsTerminal(tab.entityId, null)) {
          removed.terminalTabIds.add(tab.entityId)
        }
      } else if (tab.contentType === 'browser') {
        removed.browserTabIds.add(tab.entityId)
      } else if (
        toVisibleTabType(tab.contentType) !== 'editor' ||
        // Why: a stale editor tab with no open file has nothing for the file close to find.
        !state.openFiles.some((file) => file.id === tab.entityId)
      ) {
        removed.otherTabIds.add(tab.id)
        if (tab.contentType === 'agent-session') {
          removed.conversationIds.add(tab.entityId)
        }
      }
    }
  }
  return removed
}

/** Keeps the three selection fields consistent once the removed host's copy is gone. */
export function twinSelectionPatch(
  state: Pick<
    AppState,
    | 'activeWorktreeId'
    | 'activeWorkspaceExecutionHostId'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
  >,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId
): Partial<AppState> {
  // Why: with no surviving twin, the bulk purge owns the selection exactly as before.
  if (twinHostIds.size === 0) {
    return {}
  }
  const selected = state.activeWorkspaceExecutionHostId
  // Why canonicalized: a copy reached through a paired runtime is selected under that runtime's id.
  const candidates = state.activeWorktreeId ? [state.activeWorktreeId] : [...twinHostIds.keys()]
  const selectsRemovedHost =
    selected === removedHostId ||
    (selected !== null &&
      candidates.some(
        (worktreeId) =>
          twinHostIds.has(worktreeId) &&
          removedHostCanonicalizer(
            state,
            worktreeId,
            removedHostId,
            twinHostIds.get(worktreeId) ?? []
          )(selected) === removedHostId
      ))
  if (!selectsRemovedHost) {
    return {}
  }
  const survivor = state.activeWorktreeId ? twinHostIds.get(state.activeWorktreeId)?.[0] : null
  if (survivor) {
    return { activeWorkspaceExecutionHostId: survivor }
  }
  // Why: a teardown close already deselected the workspace; nothing may still name the removed host.
  return state.activeWorktreeId === null
    ? { activeWorkspaceKey: null, activeWorkspaceExecutionHostId: null }
    : {}
}
