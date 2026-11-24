import { stampedTaskTitle } from '../../../../../shared/orchestration/workers/worker-tab-stamp'
import {
  projectedStructuredChatTabSavedName,
  type StructuredChatTabNames
} from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { GitFileStatus } from '../../../../../shared/git/status/git-status-types'
import type {
  Tab,
  WorkspaceVisibleTabType
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'
import { normalizeRelativePath } from '../../../../../shared/file-access/cross-platform-path'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { tabItemLabel } from './tab-bar-item-label'
import type { DropIndicator } from '../strip/drop-indicator'
import { reconcileTabOrder } from '../../../lib/workspace/tabs/order/reconcile-tab-order'
import { resolveTabIndicatorEdges } from '../../tab-group/drag/tab-insertion'
import type { HoveredTabInsertion } from '../../tab-group/drag/tab-insertion'
import type { Translate } from '@/i18n/use-translate'

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
      data: BrowserWorkspace & { tabId?: string }
    }
  | { type: 'simulator'; id: string; unifiedTabId: string; isPinned: boolean; data: Tab }
  /** A bot group's room, drawn from its unified tab alone like the simulator. */
  | { type: 'room'; id: string; unifiedTabId: string; isPinned: boolean; data: Tab }
  | {
      type: 'agent-session'
      id: string
      unifiedTabId: string
      isPinned: boolean
      data: Tab & { contentType: 'agent-session' }
    }

/** The terminal tab as the strip shows it: its title resolved against the generated-titles setting. */
export { resolveTerminalItemTab } from './tab-bar-item-label'

export function resolveEditorTabGitStatus(
  file: Pick<OpenFile, 'mode' | 'relativePath'>,
  statusByRelativePath: Map<string, GitFileStatus>
): GitFileStatus | null {
  if (file.relativePath === 'All Changes' || isVirtualEditorFile(file)) {
    return null
  }
  return statusByRelativePath.get(normalizeRelativePath(file.relativePath)) ?? null
}

/** `conversationName` is the chat's reactive host name; null when unnamed or not a chat tab. */
export function getTabDragLabel(
  item: TabBarItem,
  generatedTitlesEnabled: boolean,
  conversationName: string | null,
  t?: Translate
): string {
  return tabItemLabel(
    item,
    generatedTitlesEnabled,
    item.type === 'agent-session'
      ? item.data.customLabel?.trim() ||
          item.data.quickCommandLabel?.trim() ||
          stampedTaskTitle(item.data) ||
          conversationName
      : null,
    t
  )
}

export function getTabLayoutSignature(
  item: TabBarItem,
  {
    generatedTitlesEnabled,
    isExpanded,
    status,
    chatNames
  }: {
    generatedTitlesEnabled: boolean
    isExpanded: boolean
    status?: string | null
    chatNames: StructuredChatTabNames
  },
  t?: Translate
): string {
  const label = tabItemLabel(
    item,
    generatedTitlesEnabled,
    item.type === 'agent-session'
      ? projectedStructuredChatTabSavedName(item.data, chatNames)
      : null,
    t
  )
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
  roomTabIds = [],
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
  roomTabIds?: string[]
  agentSessionTabIds: string[]
  terminalMap: Map<string, TerminalTab & { unifiedTabId?: string }>
  editorMap: Map<string, OpenFile & { tabId?: string }>
  browserMap: Map<string, BrowserWorkspace & { tabId?: string }>
  agentSessionMap: Map<string, Tab & { contentType: 'agent-session' }>
  unifiedTabByVisibleId: Map<string, Tab>
}): TabBarItem[] {
  const ids = reconcileTabOrder(
    tabBarOrder,
    terminalIds,
    editorFileIds,
    browserTabIds,
    [...simulatorTabIds, ...roomTabIds],
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
    const recordless = unifiedTabByVisibleId.get(id)
    if (recordless?.contentType === 'simulator' || recordless?.contentType === 'room') {
      items.push({
        type: recordless.contentType,
        id,
        unifiedTabId: recordless.id,
        isPinned: recordless.isPinned === true,
        data: recordless
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
    if (item.type === 'agent-session' || item.type === 'room') {
      // Structured-chat callers pass their unified tab ID; the background terminal’s activeTabId cannot identify this item.
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
  statusByRelativePath: Map<string, string>,
  chatNames: StructuredChatTabNames,
  t?: Translate
): string {
  return items
    .map((item) =>
      getTabLayoutSignature(
        item,
        {
          generatedTitlesEnabled,
          chatNames,
          isExpanded: expandedPaneByTabId[item.id] === true,
          status:
            item.type === 'editor'
              ? (statusByRelativePath.get(normalizeRelativePath(item.data.relativePath)) ?? null)
              : null
        },
        t
      )
    )
    .join('\u001f')
}
