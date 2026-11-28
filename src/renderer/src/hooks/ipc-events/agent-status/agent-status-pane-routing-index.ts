import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import '../../../components/terminal-pane/layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '../../../store/types'

type AgentStatusPaneResolution = {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
  titleUsesTabTitle: boolean
  tabTitle: string | undefined
}

type AgentStatusWorktreeConnectionResolution = {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
}

type IndexedAgentStatusTabs = {
  tabById: Map<string, AppState['tabsByWorktree'][string][number]>
  ownerByTabId: Map<string, string>
}

export type AgentStatusPaneRoutingIndex = {
  tabs: IndexedAgentStatusTabs
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
  unifiedLabelsByWorktreeId: Map<string, Map<string, string | undefined>>
  layoutsByTabId: AppState['terminalLayoutsByTabId']
  leafIdsByRoot: WeakMap<TerminalPaneLayoutNode, Set<string>>
  worktreesById: ReturnType<typeof getIndexedWorktreeMap>
  reposById: ReturnType<typeof getIndexedRepoMap>
}

/** Deterministic build accounting for the memoization ratchet test and the routing benchmark. */
export const agentStatusPaneRoutingIndexCounters = {
  indexBuilds: 0,
  tabIndexBuilds: 0,
  tabVisits: 0,
  unifiedLabelIndexBuilds: 0,
  leafSetBuilds: 0
}

export function resetAgentStatusPaneRoutingIndexCounters(): void {
  agentStatusPaneRoutingIndexCounters.indexBuilds = 0
  agentStatusPaneRoutingIndexCounters.tabIndexBuilds = 0
  agentStatusPaneRoutingIndexCounters.tabVisits = 0
  agentStatusPaneRoutingIndexCounters.unifiedLabelIndexBuilds = 0
  agentStatusPaneRoutingIndexCounters.leafSetBuilds = 0
}

// Immutable layout roots keep cached leaf membership valid without rewalking each commit.
const leafIdsByRoot = new WeakMap<TerminalPaneLayoutNode, Set<string>>()
const tabsByIdCache = new WeakMap<AppState['tabsByWorktree'], IndexedAgentStatusTabs>()
const unifiedLabelIndexCache = new WeakMap<object, Map<string, Map<string, string | undefined>>>()
const routingIndexCache = new WeakMap<
  AppState['tabsByWorktree'],
  WeakMap<object, AgentStatusPaneRoutingIndex>
>()
const NO_UNIFIED_TABS = {}
const NO_LAYOUTS = {}

function createUnifiedTerminalLabelIndex(
  entries: AppState['unifiedTabsByWorktree'][string] | undefined
): Map<string, string | undefined> {
  agentStatusPaneRoutingIndexCounters.unifiedLabelIndexBuilds += 1
  const labelsByTabId = new Map<string, string | undefined>()
  for (const entry of entries ?? []) {
    if (entry.contentType !== 'terminal' || labelsByTabId.has(entry.entityId)) {
      continue
    }
    const rawLabel = entry.label?.trim()
    labelsByTabId.set(entry.entityId, rawLabel && rawLabel.length > 0 ? rawLabel : undefined)
  }
  return labelsByTabId
}

function getIndexedTabs(tabsByWorktree: AppState['tabsByWorktree']): IndexedAgentStatusTabs {
  const cached = tabsByIdCache.get(tabsByWorktree)
  if (cached) {
    return cached
  }
  agentStatusPaneRoutingIndexCounters.tabIndexBuilds += 1
  const tabById = new Map<string, AppState['tabsByWorktree'][string][number]>()
  const ownerByTabId = new Map<string, string>()
  for (const worktreeId in tabsByWorktree) {
    if (!Object.hasOwn(tabsByWorktree, worktreeId)) {
      continue
    }
    const tabs = tabsByWorktree[worktreeId]
    if (!tabs) {
      continue
    }
    for (const tab of tabs) {
      agentStatusPaneRoutingIndexCounters.tabVisits += 1
      // Read the id once: retained selectors assert one read per row, and it is a getter on some snapshots.
      const tabId = tab.id
      // First wins: the standalone resolver stops at the first worktree owning this tab id.
      if (!tabById.has(tabId)) {
        tabById.set(tabId, tab)
        ownerByTabId.set(tabId, worktreeId)
      }
    }
  }
  const indexed: IndexedAgentStatusTabs = { tabById, ownerByTabId }
  tabsByIdCache.set(tabsByWorktree, indexed)
  return indexed
}

function getUnifiedLabelIndex(
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
): Map<string, Map<string, string | undefined>> {
  const cacheKey = unifiedTabsByWorktree ?? NO_UNIFIED_TABS
  const cached = unifiedLabelIndexCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const labelsByWorktreeId = new Map<string, Map<string, string | undefined>>()
  unifiedLabelIndexCache.set(cacheKey, labelsByWorktreeId)
  return labelsByWorktreeId
}

function resolveUnifiedLabel(
  index: AgentStatusPaneRoutingIndex,
  worktreeId: string,
  tabId: string
): string | undefined {
  let labelsByTabId = index.unifiedLabelsByWorktreeId.get(worktreeId)
  if (!labelsByTabId) {
    labelsByTabId = createUnifiedTerminalLabelIndex(index.unifiedTabsByWorktree?.[worktreeId])
    index.unifiedLabelsByWorktreeId.set(worktreeId, labelsByTabId)
  }
  return labelsByTabId.get(tabId)
}

/** Memoize ownership by relevant slice identity so status-only bursts reuse tab/label indexes. */
export function createAgentStatusPaneRoutingIndex(store: AppState): AgentStatusPaneRoutingIndex {
  const worktreesById = getIndexedWorktreeMap(selectWorktreesByRepo(store))
  const reposById = getIndexedRepoMap(store.repos)
  const layoutsKey = store.terminalLayoutsByTabId ?? NO_LAYOUTS
  let indexesByLayout = routingIndexCache.get(store.tabsByWorktree)
  const cached = indexesByLayout?.get(layoutsKey)
  if (
    cached &&
    cached.unifiedTabsByWorktree === store.unifiedTabsByWorktree &&
    cached.layoutsByTabId === store.terminalLayoutsByTabId &&
    cached.worktreesById === worktreesById &&
    cached.reposById === reposById
  ) {
    return cached
  }
  agentStatusPaneRoutingIndexCounters.indexBuilds += 1
  const index: AgentStatusPaneRoutingIndex = {
    tabs: getIndexedTabs(store.tabsByWorktree),
    unifiedTabsByWorktree: store.unifiedTabsByWorktree,
    unifiedLabelsByWorktreeId: getUnifiedLabelIndex(store.unifiedTabsByWorktree),
    layoutsByTabId: store.terminalLayoutsByTabId,
    leafIdsByRoot,
    worktreesById,
    reposById
  }
  if (!indexesByLayout) {
    indexesByLayout = new WeakMap()
    routingIndexCache.set(store.tabsByWorktree, indexesByLayout)
  }
  indexesByLayout.set(layoutsKey, index)
  return index
}

export function resolveWorktreeConnectionFromRoutingIndex(
  index: AgentStatusPaneRoutingIndex,
  worktreeId: string
): AgentStatusWorktreeConnectionResolution {
  const worktree = index.worktreesById.get(worktreeId)
  if (!worktree) {
    return { worktreeExists: false, repoConnectionId: null, repoConnectionResolved: false }
  }
  const repo = index.reposById.get(worktree.repoId)
  return {
    worktreeExists: true,
    repoConnectionId: repo?.connectionId ?? null,
    repoConnectionResolved: repo !== undefined
  }
}

export function resolvePaneKeyFromRoutingIndex(
  index: AgentStatusPaneRoutingIndex,
  paneKey: string
): AgentStatusPaneResolution {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  const { tabId, leafId } = parsed
  const tab = index.tabs.tabById.get(tabId)
  const owningWorktreeId = index.tabs.ownerByTabId.get(tabId)
  if (!tab || owningWorktreeId === undefined) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  const connection = resolveWorktreeConnectionFromRoutingIndex(index, owningWorktreeId)
  const layout = index.layoutsByTabId?.[tabId]
  if (layout?.root) {
    let leafIds = index.leafIdsByRoot.get(layout.root)
    if (!leafIds) {
      agentStatusPaneRoutingIndexCounters.leafSetBuilds += 1
      leafIds = new Set(collectLayoutLeafIdsInOrder(layout.root))
      index.leafIdsByRoot.set(layout.root, leafIds)
    }
    if (!leafIds.has(leafId)) {
      return {
        exists: false,
        title: undefined,
        identityTitle: undefined,
        repoConnectionId: connection.repoConnectionId,
        repoConnectionResolved: connection.repoConnectionResolved,
        owningWorktreeId,
        titleUsesTabTitle: false,
        tabTitle: undefined
      }
    }
  }
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists: true,
    title: paneTitle ?? tab.title,
    identityTitle: paneTitle ?? resolveUnifiedLabel(index, owningWorktreeId, tabId) ?? tab.title,
    repoConnectionId: connection.repoConnectionId,
    repoConnectionResolved: connection.repoConnectionResolved,
    owningWorktreeId,
    titleUsesTabTitle: paneTitle === undefined,
    tabTitle: tab.title
  }
}
