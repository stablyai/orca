import type { WorkspaceSessionState } from './types'
import {
  chooseSleepingRecord,
  collectTerminalProvenance,
  collectWorkspaceKeys,
  layoutLeafCount,
  mergeBrowserHistory,
  mergeTerminalLayout,
  mergeTopologyRevisions,
  mergeUnique,
  mergeWorkspaceRecord,
  paneLeafId,
  paneTabId,
  sourceOwnsTerminalMembership
} from './workspace-session-partition-provenance'

export type WorkspaceSessionPartitionAdoption = {
  session: WorkspaceSessionState
  reconciledWorktreeIds: string[]
  sourceAuthoritativeWorktreeIds: string[]
  sourceAuthoritativePaneKeys: string[]
}

export function adoptOrphanedWorkspaceSessionPartition(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState | null | undefined
): WorkspaceSessionPartitionAdoption {
  if (!source) {
    return {
      session: base,
      reconciledWorktreeIds: [],
      sourceAuthoritativeWorktreeIds: [],
      sourceAuthoritativePaneKeys: []
    }
  }
  const sourceKeys = collectWorkspaceKeys(source)
  const sourceAuthority = new Set(
    [...sourceKeys].filter((key) => sourceOwnsTerminalMembership(base, source, key))
  )
  const tabsByWorktree = mergeWorkspaceRecord(
    base.tabsByWorktree,
    source.tabsByWorktree,
    sourceKeys,
    sourceAuthority
  ) ?? { ...base.tabsByWorktree }
  const { liveTabIds, touchedTabIds, sourceWorkspaceKeyByTabId, sourcePaneAuthority } =
    collectTerminalProvenance(base, source, tabsByWorktree, sourceKeys, sourceAuthority)
  const sourcePaneAuthoritativeTabIds = new Set(
    [...sourcePaneAuthority].map((paneKey) => paneTabId(paneKey))
  )
  for (const key of sourceKeys) {
    if (sourceAuthority.has(key)) {
      continue
    }
    const sourceTabsById = new Map(
      (source.tabsByWorktree[key] ?? []).map((tab) => [tab.id, tab] as const)
    )
    tabsByWorktree[key] = (tabsByWorktree[key] ?? []).map((tab) => {
      const sourceTab = sourceTabsById.get(tab.id)
      return sourceTab?.ptyId && sourcePaneAuthoritativeTabIds.has(tab.id)
        ? { ...tab, ptyId: sourceTab.ptyId }
        : tab
    })
  }

  const terminalLayoutsByTabId = { ...base.terminalLayoutsByTabId }
  const remoteSessionIdsByTabId = { ...base.remoteSessionIdsByTabId }
  for (const tabId of touchedTabIds) {
    if (!liveTabIds.has(tabId)) {
      delete terminalLayoutsByTabId[tabId]
      delete remoteSessionIdsByTabId[tabId]
      continue
    }
    const sourceLayout = source.terminalLayoutsByTabId[tabId]
    const sourceWorkspaceKey = sourceWorkspaceKeyByTabId.get(tabId)
    terminalLayoutsByTabId[tabId] =
      sourceWorkspaceKey && sourceAuthority.has(sourceWorkspaceKey)
        ? (sourceLayout ?? terminalLayoutsByTabId[tabId])
        : (mergeTerminalLayout(
            terminalLayoutsByTabId[tabId],
            sourceLayout,
            tabId,
            sourcePaneAuthority
          ) ?? terminalLayoutsByTabId[tabId])
    if (
      source.remoteSessionIdsByTabId?.[tabId] !== undefined &&
      ((sourceWorkspaceKey && sourceAuthority.has(sourceWorkspaceKey)) ||
        remoteSessionIdsByTabId[tabId] === undefined ||
        sourcePaneAuthoritativeTabIds.has(tabId))
    ) {
      remoteSessionIdsByTabId[tabId] = source.remoteSessionIdsByTabId[tabId]
    }
  }

  const terminalPtyIncarnationsByPaneKey = { ...base.terminalPtyIncarnationsByPaneKey }
  for (const [paneKey, incarnationId] of Object.entries(
    source.terminalPtyIncarnationsByPaneKey ?? {}
  )) {
    if (sourcePaneAuthority.has(paneKey)) {
      terminalPtyIncarnationsByPaneKey[paneKey] = incarnationId
    }
  }
  for (const paneKey of Object.keys(terminalPtyIncarnationsByPaneKey)) {
    if (touchedTabIds.has(paneTabId(paneKey)) && !liveTabIds.has(paneTabId(paneKey))) {
      delete terminalPtyIncarnationsByPaneKey[paneKey]
    }
  }

  const terminalSurfaceTombstonesByPaneKey = {
    ...base.terminalSurfaceTombstonesByPaneKey
  }
  for (const [paneKey, tombstone] of Object.entries(
    source.terminalSurfaceTombstonesByPaneKey ?? {}
  )) {
    const liveIncarnation = terminalPtyIncarnationsByPaneKey[paneKey]
    if (!liveIncarnation || liveIncarnation === tombstone.incarnationId) {
      terminalSurfaceTombstonesByPaneKey[paneKey] = tombstone
    }
  }
  for (const paneKey of sourcePaneAuthority) {
    const tombstone = terminalSurfaceTombstonesByPaneKey[paneKey]
    const sourceIncarnation = source.terminalPtyIncarnationsByPaneKey?.[paneKey]
    const sourceWorkspaceKey = sourceWorkspaceKeyByTabId.get(paneTabId(paneKey))
    const sourcePtyId =
      source.terminalLayoutsByTabId[paneTabId(paneKey)]?.ptyIdsByLeafId?.[paneLeafId(paneKey)]
    if (
      tombstone &&
      ((sourceIncarnation && tombstone.incarnationId !== sourceIncarnation) ||
        (!sourceIncarnation &&
          sourceWorkspaceKey &&
          sourceAuthority.has(sourceWorkspaceKey) &&
          sourcePtyId &&
          sourcePtyId !== tombstone.ptyId))
    ) {
      delete terminalSurfaceTombstonesByPaneKey[paneKey]
    }
  }

  const retiredTabIds = new Set<string>()
  for (const [paneKey, tombstone] of Object.entries(terminalSurfaceTombstonesByPaneKey)) {
    const incarnation = terminalPtyIncarnationsByPaneKey[paneKey]
    const layout = terminalLayoutsByTabId[tombstone.parentTabId]
    if (
      (!incarnation || incarnation === tombstone.incarnationId) &&
      layoutLeafCount(layout?.root ?? null) <= 1
    ) {
      retiredTabIds.add(tombstone.parentTabId)
    }
  }
  for (const [workspaceKey, tabs] of Object.entries(tabsByWorktree)) {
    tabsByWorktree[workspaceKey] = tabs.filter((tab) => !retiredTabIds.has(tab.id))
  }
  for (const tabId of retiredTabIds) {
    liveTabIds.delete(tabId)
    delete terminalLayoutsByTabId[tabId]
    delete remoteSessionIdsByTabId[tabId]
    for (const paneKey of Object.keys(terminalPtyIncarnationsByPaneKey)) {
      if (paneTabId(paneKey) === tabId) {
        delete terminalPtyIncarnationsByPaneKey[paneKey]
      }
    }
  }

  const sleepingAgentSessionsByPaneKey = { ...base.sleepingAgentSessionsByPaneKey }
  for (const [paneKey, record] of Object.entries(source.sleepingAgentSessionsByPaneKey ?? {})) {
    if (!sourceKeys.has(record.worktreeId)) {
      continue
    }
    const tombstone = terminalSurfaceTombstonesByPaneKey[paneKey]
    if (!tombstone || tombstone.incarnationId !== terminalPtyIncarnationsByPaneKey[paneKey]) {
      sleepingAgentSessionsByPaneKey[paneKey] = chooseSleepingRecord(
        sleepingAgentSessionsByPaneKey[paneKey],
        record
      )
    }
  }
  for (const [paneKey, record] of Object.entries(sleepingAgentSessionsByPaneKey)) {
    if (sourceKeys.has(record.worktreeId) && record.tabId && retiredTabIds.has(record.tabId)) {
      delete sleepingAgentSessionsByPaneKey[paneKey]
    }
  }

  const browserPagesByWorkspace = { ...base.browserPagesByWorkspace }
  for (const [workspaceId, pages] of Object.entries(source.browserPagesByWorkspace ?? {})) {
    if (
      browserPagesByWorkspace[workspaceId] === undefined ||
      pages.some((page) => sourceAuthority.has(page.worktreeId))
    ) {
      browserPagesByWorkspace[workspaceId] = pages
    }
  }

  const session: WorkspaceSessionState = {
    ...source,
    ...base,
    activeRepoId: base.activeRepoId ?? source.activeRepoId,
    activeWorkspaceKey: base.activeWorkspaceKey ?? source.activeWorkspaceKey,
    activeWorkspaceExecutionHostId:
      base.activeWorkspaceExecutionHostId ?? source.activeWorkspaceExecutionHostId,
    activeWorktreeId: base.activeWorktreeId ?? source.activeWorktreeId,
    activeTabId: base.activeTabId ?? source.activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId,
    openFilesByWorktree: mergeWorkspaceRecord(
      base.openFilesByWorktree,
      source.openFilesByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    activeFileIdByWorktree: mergeWorkspaceRecord(
      base.activeFileIdByWorktree,
      source.activeFileIdByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    browserTabsByWorktree: mergeWorkspaceRecord(
      base.browserTabsByWorktree,
      source.browserTabsByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    browserPagesByWorkspace,
    browserUrlHistory: mergeBrowserHistory(base.browserUrlHistory, source.browserUrlHistory),
    markdownFrontmatterVisible: {
      ...source.markdownFrontmatterVisible,
      ...base.markdownFrontmatterVisible
    },
    activeBrowserTabIdByWorktree: mergeWorkspaceRecord(
      base.activeBrowserTabIdByWorktree,
      source.activeBrowserTabIdByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    activeTabTypeByWorktree: mergeWorkspaceRecord(
      base.activeTabTypeByWorktree,
      source.activeTabTypeByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    activeTabIdByWorktree: mergeWorkspaceRecord(
      base.activeTabIdByWorktree,
      source.activeTabIdByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    unifiedTabs: mergeWorkspaceRecord(
      base.unifiedTabs,
      source.unifiedTabs,
      sourceKeys,
      sourceAuthority
    ),
    tabGroups: mergeWorkspaceRecord(base.tabGroups, source.tabGroups, sourceKeys, sourceAuthority),
    tabGroupLayouts: mergeWorkspaceRecord(
      base.tabGroupLayouts,
      source.tabGroupLayouts,
      sourceKeys,
      sourceAuthority
    ),
    activeGroupIdByWorktree: mergeWorkspaceRecord(
      base.activeGroupIdByWorktree,
      source.activeGroupIdByWorktree,
      sourceKeys,
      sourceAuthority
    ),
    lastVisitedAtByWorktreeId: mergeWorkspaceRecord(
      base.lastVisitedAtByWorktreeId,
      source.lastVisitedAtByWorktreeId,
      sourceKeys,
      sourceAuthority
    ),
    defaultTerminalTabsAppliedByWorktreeId: mergeWorkspaceRecord(
      base.defaultTerminalTabsAppliedByWorktreeId,
      source.defaultTerminalTabsAppliedByWorktreeId,
      sourceKeys,
      sourceAuthority
    ),
    activeWorktreeIdsOnShutdown: mergeUnique(
      base.activeWorktreeIdsOnShutdown,
      source.activeWorktreeIdsOnShutdown
    ),
    activeConnectionIdsAtShutdown: mergeUnique(
      base.activeConnectionIdsAtShutdown,
      source.activeConnectionIdsAtShutdown
    ),
    remoteSessionIdsByTabId,
    sleepingAgentSessionsByPaneKey,
    terminalPtyIncarnationsByPaneKey,
    terminalTopologyRevisionByRepoId: mergeTopologyRevisions(
      base.terminalTopologyRevisionByRepoId,
      source.terminalTopologyRevisionByRepoId
    ),
    terminalSurfaceTombstonesByPaneKey
  }
  return {
    session,
    reconciledWorktreeIds: [...sourceKeys],
    sourceAuthoritativeWorktreeIds: [...sourceAuthority],
    sourceAuthoritativePaneKeys: [...sourcePaneAuthority]
  }
}
