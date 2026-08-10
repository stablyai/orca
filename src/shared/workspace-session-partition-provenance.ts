import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { BrowserHistoryEntry, TerminalLayoutSnapshot, WorkspaceSessionState } from './types'
import { parseWorkspaceKey } from './workspace-scope'
import { getRepoIdFromWorktreeId } from './worktree-id'

const WORKTREE_RECORD_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export function paneTabId(paneKey: string): string {
  const separator = paneKey.indexOf(':')
  return separator < 0 ? paneKey : paneKey.slice(0, separator)
}

export function paneLeafId(paneKey: string): string {
  const separator = paneKey.indexOf(':')
  return separator < 0 ? '' : paneKey.slice(separator + 1)
}

function repoIdForWorkspaceKey(key: string): string | null {
  const scope = parseWorkspaceKey(key)
  if (scope?.type === 'folder') {
    return null
  }
  return getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : key)
}

function sourceBindingRevisionIsCurrent(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string | undefined
): boolean {
  if (!workspaceKey) {
    return false
  }
  const repoId = repoIdForWorkspaceKey(workspaceKey)
  if (!repoId) {
    return true
  }
  return (
    (source.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) >=
    (base.terminalTopologyRevisionByRepoId?.[repoId] ?? 0)
  )
}

export function collectWorkspaceKeys(session: WorkspaceSessionState): Set<string> {
  const keys = new Set<string>()
  for (const field of WORKTREE_RECORD_FIELDS) {
    for (const key of Object.keys((session[field] as Record<string, unknown> | undefined) ?? {})) {
      keys.add(key)
    }
  }
  for (const key of session.activeWorktreeIdsOnShutdown ?? []) {
    keys.add(key)
  }
  if (session.activeWorktreeId) {
    keys.add(session.activeWorktreeId)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    for (const page of pages) {
      keys.add(page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    keys.add(record.worktreeId)
  }
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    keys.add(tombstone.worktreeId)
  }
  return keys
}

export function collectTerminalProvenance(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  tabsByWorktree: WorkspaceSessionState['tabsByWorktree'],
  sourceKeys: ReadonlySet<string>,
  sourceAuthority: ReadonlySet<string>
): {
  liveTabIds: Set<string>
  touchedTabIds: Set<string>
  sourceWorkspaceKeyByTabId: Map<string, string>
  sourcePaneAuthority: Set<string>
} {
  const liveTabIds = new Set(
    Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const touchedTabIds = new Set(
    [...sourceKeys].flatMap((key) => [
      ...(base.tabsByWorktree[key] ?? []).map((tab) => tab.id),
      ...(source.tabsByWorktree[key] ?? []).map((tab) => tab.id)
    ])
  )
  const sourceWorkspaceKeyByTabId = new Map<string, string>()
  for (const key of sourceKeys) {
    for (const tab of source.tabsByWorktree[key] ?? []) {
      sourceWorkspaceKeyByTabId.set(tab.id, key)
    }
  }
  const sourcePaneAuthority = new Set<string>()
  for (const [paneKey, incarnationId] of Object.entries(
    source.terminalPtyIncarnationsByPaneKey ?? {}
  )) {
    const baseTombstone = base.terminalSurfaceTombstonesByPaneKey?.[paneKey]
    if (
      liveTabIds.has(paneTabId(paneKey)) &&
      sourceBindingRevisionIsCurrent(
        base,
        source,
        sourceWorkspaceKeyByTabId.get(paneTabId(paneKey))
      ) &&
      (!baseTombstone || baseTombstone.incarnationId !== incarnationId)
    ) {
      sourcePaneAuthority.add(paneKey)
    }
  }
  for (const key of sourceAuthority) {
    for (const tab of source.tabsByWorktree[key] ?? []) {
      for (const leafId of Object.keys(
        source.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        sourcePaneAuthority.add(`${tab.id}:${leafId}`)
      }
    }
  }
  return { liveTabIds, touchedTabIds, sourceWorkspaceKeyByTabId, sourcePaneAuthority }
}

export function mergeWorkspaceRecord<T>(
  base: Record<string, T> | undefined,
  source: Record<string, T> | undefined,
  sourceKeys: ReadonlySet<string>,
  sourceAuthority: ReadonlySet<string>
): Record<string, T> | undefined {
  if (!base && !source) {
    return undefined
  }
  const merged = { ...base }
  for (const key of sourceKeys) {
    const value = source?.[key]
    if (value !== undefined && (sourceAuthority.has(key) || merged[key] === undefined)) {
      merged[key] = value
    }
  }
  return merged
}

export function sourceOwnsTerminalMembership(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState,
  workspaceKey: string
): boolean {
  const baseTabs = base.tabsByWorktree[workspaceKey] ?? []
  const sourceTabs = source.tabsByWorktree[workspaceKey] ?? []
  const repoId = repoIdForWorkspaceKey(workspaceKey)
  if (!repoId) {
    return sourceTabs.length > 0 && baseTabs.length === 0
  }
  const baseRevision = base.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
  const sourceRevision = source.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
  return (
    sourceRevision > baseRevision ||
    (sourceRevision === baseRevision && sourceTabs.length > 0 && baseTabs.length === 0)
  )
}

function layoutContainsLeaf(root: TerminalLayoutSnapshot['root'], leafId: string): boolean {
  if (!root) {
    return false
  }
  return root.type === 'leaf'
    ? root.leafId === leafId
    : layoutContainsLeaf(root.first, leafId) || layoutContainsLeaf(root.second, leafId)
}

export function layoutLeafCount(root: TerminalLayoutSnapshot['root']): number {
  if (!root) {
    return 0
  }
  return root.type === 'leaf' ? 1 : layoutLeafCount(root.first) + layoutLeafCount(root.second)
}

export function mergeTerminalLayout(
  base: TerminalLayoutSnapshot | undefined,
  source: TerminalLayoutSnapshot | undefined,
  tabId: string,
  sourcePaneAuthority: ReadonlySet<string>
): TerminalLayoutSnapshot | undefined {
  if (!base || !source) {
    return base ?? source
  }
  const ptyIdsByLeafId = { ...base.ptyIdsByLeafId }
  for (const [leafId, ptyId] of Object.entries(source.ptyIdsByLeafId ?? {})) {
    const paneKey = `${tabId}:${leafId}`
    if (
      (sourcePaneAuthority.has(paneKey) || ptyIdsByLeafId[leafId] === undefined) &&
      layoutContainsLeaf(base.root, leafId)
    ) {
      ptyIdsByLeafId[leafId] = ptyId
    }
  }
  const merged: TerminalLayoutSnapshot = { ...source, ...base, ptyIdsByLeafId }
  if (source.buffersByLeafId || base.buffersByLeafId) {
    merged.buffersByLeafId = { ...source.buffersByLeafId, ...base.buffersByLeafId }
  }
  if (source.scrollbackRefsByLeafId || base.scrollbackRefsByLeafId) {
    merged.scrollbackRefsByLeafId = {
      ...source.scrollbackRefsByLeafId,
      ...base.scrollbackRefsByLeafId
    }
  }
  if (source.titlesByLeafId || base.titlesByLeafId) {
    merged.titlesByLeafId = { ...source.titlesByLeafId, ...base.titlesByLeafId }
  }
  return merged
}

export function mergeTopologyRevisions(
  base: Record<string, number> | undefined,
  source: Record<string, number> | undefined
): Record<string, number> {
  const merged = { ...base }
  for (const [repoId, revision] of Object.entries(source ?? {})) {
    merged[repoId] = Math.max(merged[repoId] ?? 0, revision)
  }
  return merged
}

export function chooseSleepingRecord(
  base: SleepingAgentSessionRecord | undefined,
  source: SleepingAgentSessionRecord
): SleepingAgentSessionRecord {
  return !base || source.updatedAt >= base.updatedAt ? source : base
}

export function mergeUnique(
  values: readonly string[] | undefined,
  incoming: readonly string[] | undefined
): string[] {
  return [...new Set([...(values ?? []), ...(incoming ?? [])])]
}

export function mergeBrowserHistory(
  base: readonly BrowserHistoryEntry[] | undefined,
  source: readonly BrowserHistoryEntry[] | undefined
): BrowserHistoryEntry[] {
  const entries = new Map(source?.map((entry) => [entry.normalizedUrl, entry]))
  for (const entry of base ?? []) {
    const current = entries.get(entry.normalizedUrl)
    if (!current || entry.lastVisitedAt >= current.lastVisitedAt) {
      entries.set(entry.normalizedUrl, entry)
    }
  }
  return [...entries.values()].sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
}
