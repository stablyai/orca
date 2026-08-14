import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  createWorkspaceSessionAuthorityIndex,
  findWorkspaceTabIdOwnerCollisions,
  workspaceTerminalAuthority
} from './workspace-session-partition-authority'
import { mergeAdoptedWorkspaceSessionState } from './workspace-session-partition-state-merge'
import {
  collectTerminalProvenance,
  collectWorkspaceKeys,
  layoutLeafCount,
  mergeTerminalLayout,
  mergeWorkspaceRecord,
  paneLeafId,
  paneTabId,
  tabIsPtyBound
} from './workspace-session-partition-provenance'

export type WorkspaceSessionPartitionAdoption = {
  session: WorkspaceSessionState
  reconciledWorktreeIds: string[]
  sourceAuthoritativeWorktreeIds: string[]
  sourceAuthoritativePaneKeys: string[]
  ambiguousWorktreeIds: string[]
}

type WorkspaceSessionPartitionAdoptionOptions = {
  preserveWorkspaceKeys?: ReadonlySet<string>
}

export function adoptOrphanedWorkspaceSessionPartition(
  base: WorkspaceSessionState,
  source: WorkspaceSessionState | null | undefined,
  options: WorkspaceSessionPartitionAdoptionOptions = {}
): WorkspaceSessionPartitionAdoption {
  if (!source) {
    return {
      session: base,
      reconciledWorktreeIds: [],
      sourceAuthoritativeWorktreeIds: [],
      sourceAuthoritativePaneKeys: [],
      ambiguousWorktreeIds: []
    }
  }
  const sourceKeys = collectWorkspaceKeys(source)
  const baseKeys = collectWorkspaceKeys(base)
  const baseAuthorityIndex = createWorkspaceSessionAuthorityIndex(base)
  const sourceAuthorityIndex = createWorkspaceSessionAuthorityIndex(source)
  const decisionByWorkspaceKey = new Map(
    [...sourceKeys].map((key) => [
      key,
      workspaceTerminalAuthority(
        base,
        source,
        key,
        {
          base: baseKeys.has(key),
          source: true
        },
        {
          base: baseAuthorityIndex,
          source: sourceAuthorityIndex
        }
      )
    ])
  )
  const ambiguousWorktreeIds = new Set([
    ...findWorkspaceTabIdOwnerCollisions([base, source]),
    ...[...sourceKeys].filter(
      (key) =>
        options.preserveWorkspaceKeys?.has(key) ||
        decisionByWorkspaceKey.get(key)?.authority === 'ambiguous'
    )
  ])
  const sourceAuthority = new Set(
    [...sourceKeys].filter(
      (key) =>
        !ambiguousWorktreeIds.has(key) && decisionByWorkspaceKey.get(key)?.authority === 'source'
    )
  )
  // Keys where the pty-bound veto overturned base's revision win. Base's own tab rows
  // must survive for these: base is the side that runs the topology-authority code
  // path, so its list reflects deliberate closes the source never observed. The
  // source's pty-bound strays are grafted in additively below instead of replacing
  // the list, and every other per-key field keeps base priority.
  const grafted = new Set(
    [...sourceAuthority].filter(
      (key) => decisionByWorkspaceKey.get(key)?.ptyBoundVetoFlip && base.tabsByWorktree[key]
    )
  )
  const sourceFieldAuthority = new Set([...sourceAuthority].filter((key) => !grafted.has(key)))
  const reconciledKeys = new Set([...sourceKeys].filter((key) => !ambiguousWorktreeIds.has(key)))
  const tabsByWorktree = mergeWorkspaceRecord(
    base.tabsByWorktree,
    source.tabsByWorktree,
    reconciledKeys,
    sourceFieldAuthority
  ) ?? { ...base.tabsByWorktree }
  for (const key of grafted) {
    const baseTabs = base.tabsByWorktree[key] ?? []
    const baseTabIds = new Set(baseTabs.map((tab) => tab.id))
    const strays = (source.tabsByWorktree[key] ?? []).filter(
      (tab) => !baseTabIds.has(tab.id) && tabIsPtyBound(source, tab)
    )
    if (strays.length > 0) {
      tabsByWorktree[key] = [...baseTabs, ...strays]
    }
  }
  const { liveTabIds, touchedTabIds, sourceWorkspaceKeyByTabId, sourcePaneAuthority } =
    collectTerminalProvenance(base, source, tabsByWorktree, reconciledKeys, sourceAuthority)
  const sourcePaneAuthoritativeTabIds = new Set(
    [...sourcePaneAuthority].map((paneKey) => paneTabId(paneKey))
  )
  for (const key of reconciledKeys) {
    if (sourceFieldAuthority.has(key)) {
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
  for (const paneKey of sourcePaneAuthority) {
    const incarnationId = source.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (incarnationId === undefined) {
      delete terminalPtyIncarnationsByPaneKey[paneKey]
    } else {
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
    if (!sourceAuthority.has(tombstone.worktreeId)) {
      continue
    }
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
  for (const paneKey of sourcePaneAuthority) {
    const record = source.sleepingAgentSessionsByPaneKey?.[paneKey]
    const tombstone = terminalSurfaceTombstonesByPaneKey[paneKey]
    if (
      record &&
      (!tombstone || tombstone.incarnationId !== terminalPtyIncarnationsByPaneKey[paneKey])
    ) {
      sleepingAgentSessionsByPaneKey[paneKey] = record
    } else {
      delete sleepingAgentSessionsByPaneKey[paneKey]
    }
  }
  for (const [paneKey, record] of Object.entries(sleepingAgentSessionsByPaneKey)) {
    if (reconciledKeys.has(record.worktreeId) && record.tabId && retiredTabIds.has(record.tabId)) {
      delete sleepingAgentSessionsByPaneKey[paneKey]
    }
  }

  const session = mergeAdoptedWorkspaceSessionState({
    base,
    source,
    reconciledKeys,
    sourceAuthority: sourceFieldAuthority,
    ambiguousWorktreeIds,
    tabsByWorktree,
    terminalLayoutsByTabId,
    remoteSessionIdsByTabId,
    sleepingAgentSessionsByPaneKey,
    terminalPtyIncarnationsByPaneKey,
    terminalSurfaceTombstonesByPaneKey
  })
  return {
    session,
    reconciledWorktreeIds: [...reconciledKeys],
    sourceAuthoritativeWorktreeIds: [...sourceAuthority],
    sourceAuthoritativePaneKeys: [...sourcePaneAuthority],
    ambiguousWorktreeIds: [...ambiguousWorktreeIds]
  }
}
