import type { AppState } from '../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  belongsToRemovedHost,
  isRuntimeHost,
  ptyHostEvidence,
  terminalTabBelongsToHost,
  terminalTabPtyEvidence,
  type HostEvidence
} from './host-twin-terminal-evidence'

export { belongsToRemovedHost, isRuntimeHost, type HostEvidence }
import { toVisibleTabType } from '../../../../shared/tab-types'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'

/** Worktree ids of this host's project that another host also publishes, with those hosts. */
export function getSurvivingTwinHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  projectId: string,
  hostId: ExecutionHostId
): Map<string, ExecutionHostId[]> {
  const rows = [
    ...(state.worktreesByRepo[projectId] ?? []),
    ...(state.detectedWorktreesByRepo[projectId]?.worktrees ?? [])
  ]
  const hostOf = (row: { hostId?: ExecutionHostId }): ExecutionHostId =>
    row.hostId ?? LOCAL_EXECUTION_HOST_ID
  const removedIds = new Set(rows.filter((row) => hostOf(row) === hostId).map((row) => row.id))
  const survivors = new Map<string, ExecutionHostId[]>()
  for (const row of rows) {
    const survivorHostId = hostOf(row)
    if (!removedIds.has(row.id) || survivorHostId === hostId) {
      continue
    }
    const hosts = survivors.get(row.id) ?? []
    if (!hosts.includes(survivorHostId)) {
      survivors.set(row.id, [...hosts, survivorHostId])
    }
  }
  return survivors
}

/** The twins whose surviving host still holds a row now, after the removal's host call. */
export function retainSurvivingTwinHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  projectId: string,
  twins: ReadonlyMap<string, readonly ExecutionHostId[]>
): Map<string, ExecutionHostId[]> {
  const rows = [
    ...(state.worktreesByRepo[projectId] ?? []),
    ...(state.detectedWorktreesByRepo[projectId]?.worktrees ?? [])
  ]
  const retained = new Map<string, ExecutionHostId[]>()
  for (const [worktreeId, hostIds] of twins) {
    const live = hostIds.filter((hostId) =>
      rows.some(
        (row) => row.id === worktreeId && (row.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
      )
    )
    if (live.length > 0) {
      retained.set(worktreeId, live)
    }
  }
  return retained
}

/**
 * Every id the removal covers, and those it may purge outright. State under an id another host
 * still publishes is shared, so there only the removed host's attributed tabs and files go.
 */
export function splitRemovedWorktreeIds(
  knownIds: readonly string[],
  twinsBeforeCall: ReadonlyMap<string, unknown>,
  twinsNow: ReadonlyMap<string, unknown>
): { worktreeIds: string[]; exclusiveWorktreeIds: string[] } {
  const worktreeIds = [
    ...new Set([...knownIds, ...[...twinsBeforeCall.keys()].filter((id) => !twinsNow.has(id))])
  ]
  return { worktreeIds, exclusiveWorktreeIds: worktreeIds.filter((id) => !twinsNow.has(id)) }
}

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
export function openFileHostEvidence(
  file: Parameters<typeof hasOpenFileExecutionHostEvidence>[0]
): HostEvidence {
  return hasOpenFileExecutionHostEvidence(file) ? getOpenFileExecutionHostId(file) : 'non-runtime'
}

/** A browser page's host: null is explicitly this client, absent is unknown. */
export function pageHostEvidence(page: {
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

/**
 * The settled attribution, plus pre-call entries whose surface has since disappeared. A surface
 * still present is judged on its latest evidence, which may now include a surviving host's pane.
 */
export function mergeRemovedHostTwinState(
  beforeCall: RemovedHostTwinState,
  settled: RemovedHostTwinState,
  state: Pick<
    AppState,
    'tabsByWorktree' | 'unifiedTabsByWorktree' | 'openFiles' | 'browserTabsByWorktree'
  >
): RemovedHostTwinState {
  const terminalIds = new Set([
    ...Object.values(state.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id)),
    ...Object.values(state.unifiedTabsByWorktree).flatMap((tabs) =>
      tabs.flatMap((tab) => (tab.contentType === 'terminal' ? [tab.entityId] : []))
    )
  ])
  const unifiedIds = new Set(
    Object.values(state.unifiedTabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const fileIds = new Set(state.openFiles.map((file) => file.id))
  const browserIds = new Set(
    Object.values(state.browserTabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const keep = (a: Set<string>, b: Set<string>, present: Set<string>): Set<string> =>
    new Set([...b, ...[...a].filter((id) => !present.has(id))])
  return {
    terminalTabIds: keep(beforeCall.terminalTabIds, settled.terminalTabIds, terminalIds),
    fileIds: keep(beforeCall.fileIds, settled.fileIds, fileIds),
    browserTabIds: keep(beforeCall.browserTabIds, settled.browserTabIds, browserIds),
    otherTabIds: keep(beforeCall.otherTabIds, settled.otherTabIds, unifiedIds),
    conversationIds: new Set([...beforeCall.conversationIds, ...settled.conversationIds]),
    mixedTabPtyIds: settled.mixedTabPtyIds
  }
}
