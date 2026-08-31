import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../../store/types'

type AgentStatusPaneResolution = {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
  titleUsesTabTitle: boolean
}

type AgentStatusWorktreeConnectionResolution = {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
}

type IndexedAgentStatusTab = {
  title: string | undefined
  unifiedLabel: string | undefined
  owningWorktreeId: string
}

export type AgentStatusPaneRoutingIndex = {
  tabsById: Map<string, IndexedAgentStatusTab>
  layoutsByTabId: AppState['terminalLayoutsByTabId']
  leafIdsByRoot: WeakMap<TerminalPaneLayoutNode, Set<string>>
  worktreesById: ReturnType<typeof getWorktreeMapFromState>
  reposById: ReturnType<typeof getRepoMapFromState>
}

function createUnifiedTerminalLabelIndex(
  entries: AppState['unifiedTabsByWorktree'][string] | undefined
): Map<string, string | undefined> {
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

export function createAgentStatusPaneRoutingIndex(store: AppState): AgentStatusPaneRoutingIndex {
  const tabsById = new Map<string, IndexedAgentStatusTab>()
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    const unifiedLabelsByTabId = createUnifiedTerminalLabelIndex(
      store.unifiedTabsByWorktree?.[worktreeId]
    )
    for (const tab of tabs) {
      const tabId = tab.id
      if (!tabsById.has(tabId)) {
        tabsById.set(tabId, {
          title: tab.title,
          unifiedLabel: unifiedLabelsByTabId.get(tabId),
          owningWorktreeId: worktreeId
        })
      }
    }
  }
  return {
    tabsById,
    layoutsByTabId: store.terminalLayoutsByTabId,
    leafIdsByRoot: new WeakMap(),
    worktreesById: getWorktreeMapFromState(store),
    reposById: getRepoMapFromState(store)
  }
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
      titleUsesTabTitle: false
    }
  }
  const { tabId, leafId } = parsed
  const tab = index.tabsById.get(tabId)
  if (!tab) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false
    }
  }
  const connection = resolveWorktreeConnectionFromRoutingIndex(index, tab.owningWorktreeId)
  const layout = index.layoutsByTabId?.[tabId]
  if (layout?.root) {
    let leafIds = index.leafIdsByRoot.get(layout.root)
    if (!leafIds) {
      leafIds = new Set(collectLeafIdsInOrder(layout.root))
      index.leafIdsByRoot.set(layout.root, leafIds)
    }
    if (!leafIds.has(leafId)) {
      return {
        exists: false,
        title: undefined,
        identityTitle: undefined,
        repoConnectionId: connection.repoConnectionId,
        repoConnectionResolved: connection.repoConnectionResolved,
        owningWorktreeId: tab.owningWorktreeId,
        titleUsesTabTitle: false
      }
    }
  }
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists: true,
    title: paneTitle ?? tab.title,
    identityTitle: paneTitle ?? tab.unifiedLabel ?? tab.title,
    repoConnectionId: connection.repoConnectionId,
    repoConnectionResolved: connection.repoConnectionResolved,
    owningWorktreeId: tab.owningWorktreeId,
    titleUsesTabTitle: paneTitle === undefined
  }
}
