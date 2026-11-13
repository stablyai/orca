import type { AppState } from '../types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { collectPtyIdsForTab } from '../terminals/terminal-tab-retirement'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { isExecutionHostAliasForWorktree } from '@/lib/workspace/ownership/worktree-execution-host-alias'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { worktreePurgePublishers } from './repo-removal-publisher-index'

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

/** `foreign`: off this host, owner unresolved. `null`: no evidence either way. */
type HostEvidence = ExecutionHostId | 'non-runtime' | 'foreign' | null

const survivorSummaries = new WeakMap<
  readonly ExecutionHostId[],
  { hosts: ReadonlySet<ExecutionHostId>; allRuntime: boolean }
>()

function survivorSummary(hostIds: readonly ExecutionHostId[]) {
  let summary = survivorSummaries.get(hostIds)
  if (!summary) {
    const hosts = new Set<ExecutionHostId>()
    let allRuntime = true
    for (const hostId of hostIds) {
      hosts.add(hostId)
      if (!isRuntimeHost(hostId)) {
        allRuntime = false
      }
    }
    summary = { hosts, allRuntime }
    survivorSummaries.set(hostIds, summary)
  }
  return summary
}

const fileIndexes = new WeakMap<
  AppState['openFiles'],
  { byWorktree: Map<string, AppState['openFiles']>; ids: Set<string> }
>()

function fileIndex(files: AppState['openFiles']) {
  let index = fileIndexes.get(files)
  if (!index) {
    index = { byWorktree: new Map(), ids: new Set() }
    for (const file of files) {
      const worktreeId = file.worktreeId
      const rows = index.byWorktree.get(worktreeId) ?? []
      rows.push(file)
      index.byWorktree.set(worktreeId, rows)
      index.ids.add(file.id)
    }
    fileIndexes.set(files, index)
  }
  return index
}

export function isRuntimeHost(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

function ptyHostEvidence(ptyId: string): HostEvidence {
  const host = getPtyExecutionHost(ptyId)
  // Why: SSH and runtime PTY ids name their host, so an unprefixed one runs on a local/SSH host.
  return host ?? 'non-runtime'
}

/** Runtime files always record their environment, so an unmarked one is local/SSH. */
function openFileHostEvidence(
  file: Parameters<typeof hasOpenFileExecutionHostEvidence>[0]
): HostEvidence {
  return hasOpenFileExecutionHostEvidence(file) ? getOpenFileExecutionHostId(file) : 'non-runtime'
}

/** A browser page's host: null is explicitly this client, absent is unknown. */
function pageHostEvidence(page: { browserRuntimeEnvironmentId?: string | null }): HostEvidence {
  if (page.browserRuntimeEnvironmentId === null) {
    return 'non-runtime'
  }
  return page.browserRuntimeEnvironmentId
    ? toRuntimeExecutionHostId(page.browserRuntimeEnvironmentId)
    : null
}

/** Evidence that names a host other than the removed one; unknown evidence names none. */
function contradictsRemovedHost(evidence: HostEvidence, removedHostId: ExecutionHostId): boolean {
  if (evidence === null) {
    return false
  }
  // Why foreign contradicts: an off-host PTY with no named owner cannot be proven the removed host's.
  return evidence === 'non-runtime' ? isRuntimeHost(removedHostId) : evidence !== removedHostId
}

function belongsToRemovedHost(
  evidence: HostEvidence,
  removedHostId: ExecutionHostId,
  survivorsAllRuntime: boolean
): boolean {
  if (evidence === null || evidence === 'foreign') {
    return false
  }
  if (evidence !== 'non-runtime') {
    return evidence === removedHostId
  }
  // Non-runtime evidence names one host only when exactly one side is a local/SSH host.
  return !isRuntimeHost(removedHostId) && survivorsAllRuntime
}

/** Map transport aliases to removed host: SSH copies accessed via paired runtimes stamp launches/tabs/snapshots with runtime ID. */
export function removedHostCanonicalizer(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string,
  removedHostId: ExecutionHostId,
  survivors: readonly ExecutionHostId[]
): (evidence: HostEvidence) => HostEvidence {
  const removedRow = worktreePurgePublishers(state, worktreeId).firstForHost(removedHostId)
  const survivingHosts = survivorSummary(survivors).hosts
  return (evidence) =>
    evidence &&
    evidence !== 'non-runtime' &&
    evidence !== 'foreign' &&
    !survivingHosts.has(evidence) &&
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
  const files = fileIndex(state.openFiles)
  for (const worktreeId of twinWorktreeIds) {
    const survivors = survivingHostIdsByWorktreeId.get(worktreeId) ?? []
    const canonical = removedHostCanonicalizer(state, worktreeId, removedHostId, survivors)
    const allRuntime = survivorSummary(survivors).allRuntime
    const owns = (evidence: HostEvidence): boolean =>
      belongsToRemovedHost(canonical(evidence), removedHostId, allRuntime)
    const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const stampedHostByEntityId = new Map(
      unifiedTabs.flatMap((tab) =>
        tab.executionHostId ? [[tab.entityId, canonical(tab.executionHostId)] as const] : []
      )
    )
    const ownsTerminal = (tabId: string, rowPtyId: string | null): boolean => {
      const stamped = stampedHostByEntityId.get(tabId)
      // Why every source: a restored tab can name its host only in its layout or reconnect maps.
      const live = new Set([...(state.ptyIdsByTabId[tabId] ?? []), ...(rowPtyId ? [rowPtyId] : [])])
      // Why: an unprefixed id only in a layout or reconnect map may be a host-native hint.
      const evidence = collectPtyIdsForTab(state, tabId, rowPtyId).map((ptyId) => {
        const entry = ptyHostEvidence(ptyId)
        return entry === 'non-runtime' && !live.has(ptyId) ? null : entry
      })
      // Any off-host pane disproves exclusive attribution; PTY evidence outranks tab stamps.
      return stamped
        ? stamped === removedHostId &&
            evidence.every((entry) => !contradictsRemovedHost(canonical(entry), removedHostId))
        : evidence.length > 0 && evidence.every(owns)
    }
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
    for (const file of files.byWorktree.get(worktreeId) ?? []) {
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
        !files.ids.has(tab.entityId)
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
