import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { Tab, WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { OpenFile } from '../../store/slices/editor'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { normalizeRelativePath } from '@/lib/path'
import { getBrowserTabLabel } from './BrowserTab'
import type { DropIndicator } from './drop-indicator'
import { reconcileTabOrder } from './reconcile-order'
import { resolveTabIndicatorEdges } from '../tab-group/tab-insertion'
import type { HoveredTabInsertion } from '../tab-group/useTabDragSplit'

export type TabBarItem =
  | {
      type: 'terminal'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: TerminalTab & { unifiedTabId?: string }
    }
  | {
      type: 'editor'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: OpenFile & { tabId?: string }
    }
  | {
      type: 'browser'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: BrowserTabState & { tabId?: string }
    }
  | {
      type: 'simulator'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: Tab
    }
  | {
      type: 'agent-session'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: Tab & { contentType: 'agent-session' }
    }

export function getTabDragLabel(item: TabBarItem, generatedTitlesEnabled: boolean): string {
  if (item.type === 'terminal') {
    return resolveTerminalTabTitle(item.data, generatedTitlesEnabled, item.data.title)
  }
  if (item.type === 'browser') {
    return getBrowserTabLabel(item.data)
  }
  if (item.type === 'simulator' || item.type === 'agent-session') {
    return item.data.label || 'Mobile Emulator'
  }
  return getEditorDisplayLabel(item.data)
}

export function getTabLayoutSignature(
  item: TabBarItem,
  {
    generatedTitlesEnabled,
    isExpanded,
    status
  }: {
    generatedTitlesEnabled: boolean
    isExpanded: boolean
    status?: string | null
  }
): string {
  const label = getTabDragLabel(item, generatedTitlesEnabled)
  if (item.type === 'terminal') {
    return `${item.type}:${item.id}:${item.isPinned}:${isExpanded}:${Boolean(item.data.color)}:${label}`
  }
  if (item.type === 'browser') {
    return `${item.type}:${item.id}:${item.isPinned}:${item.data.loading}:${Boolean(item.data.loadError)}:${label}`
  }
  if (item.type === 'editor') {
    return `${item.type}:${item.id}:${item.isPinned}:${item.data.isDirty}:${item.data.isPreview}:${item.data.externalMutation ?? ''}:${status ?? ''}:${label}`
  }
  return `${item.type}:${item.id}:${item.isPinned}:${label}`
}

export function createUnifiedTabLookup(tabs: readonly Tab[], groupId: string): Map<string, Tab> {
  const lookup = new Map<string, Tab>()
  for (const tab of tabs) {
    if (tab.groupId !== groupId) {
      continue
    }
    lookup.set(tab.id, tab)
    if (tab.contentType === 'terminal' || tab.contentType === 'browser') {
      lookup.set(tab.entityId, tab)
    }
  }
  return lookup
}

export function buildOrderedTabItems({
  tabBarOrder,
  terminalIds,
  editorFileIds,
  browserTabIds,
  simulatorTabIds,
  agentSessionTabIds,
  terminalMap,
  editorMap,
  browserMap,
  agentSessionMap,
  unifiedTabByVisibleId
}: {
  tabBarOrder?: string[]
  terminalIds: string[]
  editorFileIds: string[]
  browserTabIds: string[]
  simulatorTabIds: string[]
  agentSessionTabIds: string[]
  terminalMap: Map<string, TerminalTab & { unifiedTabId?: string }>
  editorMap: Map<string, OpenFile & { tabId?: string }>
  browserMap: Map<string, BrowserTabState & { tabId?: string }>
  agentSessionMap: Map<string, Tab & { contentType: 'agent-session' }>
  unifiedTabByVisibleId: Map<string, Tab>
}): TabBarItem[] {
  const ids = reconcileTabOrder(
    tabBarOrder,
    terminalIds,
    editorFileIds,
    browserTabIds,
    simulatorTabIds,
    agentSessionTabIds
  )
  const items: TabBarItem[] = []
  for (const id of ids) {
    const terminal = terminalMap.get(id)
    if (terminal) {
      const unifiedTab = unifiedTabByVisibleId.get(id)
      items.push({
        type: 'terminal',
        id,
        unifiedTabId: terminal.unifiedTabId ?? unifiedTab?.id ?? terminal.id,
        isPinned: unifiedTab?.isPinned === true,
        data: terminal
      })
      continue
    }
    const file = editorMap.get(id)
    if (file) {
      const unifiedTab = unifiedTabByVisibleId.get(id) ?? unifiedTabByVisibleId.get(file.id)
      items.push({
        type: 'editor',
        id,
        unifiedTabId: file.tabId ?? unifiedTab?.id ?? file.id,
        isPinned: unifiedTab?.isPinned === true,
        data: file
      })
      continue
    }
    const browserTab = browserMap.get(id)
    if (browserTab) {
      const unifiedTab = unifiedTabByVisibleId.get(id)
      items.push({
        type: 'browser',
        id,
        unifiedTabId: browserTab.tabId ?? unifiedTab?.id ?? browserTab.id,
        isPinned: unifiedTab?.isPinned === true,
        data: browserTab
      })
      continue
    }
    const simulatorTab = unifiedTabByVisibleId.get(id)
    if (simulatorTab?.contentType === 'simulator') {
      items.push({
        type: 'simulator',
        id,
        unifiedTabId: simulatorTab.id,
        isPinned: simulatorTab.isPinned === true,
        data: simulatorTab
      })
      continue
    }
    const agentSession = agentSessionMap.get(id)
    if (agentSession) {
      items.push({
        type: 'agent-session',
        id,
        unifiedTabId: agentSession.id,
        isPinned: agentSession.isPinned === true,
        data: agentSession
      })
    }
  }
  return items
}

export function buildTabDropIndicators(
  items: readonly TabBarItem[],
  insertion: HoveredTabInsertion | null
): Map<string, DropIndicator> {
  const indicators = new Map<string, DropIndicator>()
  for (const edge of resolveTabIndicatorEdges(
    items.map((item) => item.id),
    insertion
  )) {
    indicators.set(edge.visibleTabId, edge.side)
  }
  return indicators
}

export function findActiveVisibleTabId(
  items: readonly TabBarItem[],
  active: {
    activeTabId: string | null
    activeFileId?: string | null
    activeBrowserTabId?: string | null
    activeSimulatorTabId?: string | null
    activeTabType?: WorkspaceVisibleTabType
  }
): string | null {
  const activeItem = items.find((item) => {
    if (item.type === 'terminal') {
      return (
        (active.activeTabType === 'terminal' || active.activeTabType === 'simulator') &&
        item.id === active.activeTabId
      )
    }
    if (item.type === 'browser') {
      return active.activeTabType === 'browser' && item.id === active.activeBrowserTabId
    }
    if (item.type === 'simulator') {
      return active.activeTabType === 'simulator' && item.id === active.activeSimulatorTabId
    }
    if (item.type === 'agent-session') {
      return active.activeTabType === 'agent-session' && item.id === active.activeTabId
    }
    return (
      (active.activeTabType === 'editor' || active.activeTabType === 'simulator') &&
      active.activeFileId === item.id
    )
  })
  return activeItem?.id ?? null
}

export function buildTabStripLayoutKey(
  items: readonly TabBarItem[],
  generatedTitlesEnabled: boolean,
  expandedPaneByTabId: Record<string, boolean>,
  statusByRelativePath: Map<string, string>
): string {
  return items
    .map((item) =>
      getTabLayoutSignature(item, {
        generatedTitlesEnabled,
        isExpanded: expandedPaneByTabId[item.id] === true,
        status:
          item.type === 'editor'
            ? (statusByRelativePath.get(normalizeRelativePath(item.data.relativePath)) ?? null)
            : null
      })
    )
    .join('\u001f')
}
