import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { getAgentRowConversationName } from '../../../../shared/agent-status/presentation/agent-row-conversation-name'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { structuredChatDisplayName } from '../../../../shared/structured-chat-row-name'
import { resolveAgentRowPaneLiveTitle } from './agent-row-pane-live-title'
import { structuredChatTabById } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/native-chat/naming/structured-conversation-name'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from './useDashboardData'

type WorktreeTabs = NonNullable<AppState['tabsByWorktree'][string]>

const tabIndexByTabs = new WeakMap<WorktreeTabs, ReadonlyMap<string, WorktreeTabs[number]>>()

function getIndexedTab(
  tabs: WorktreeTabs | undefined,
  tabId: string
): WorktreeTabs[number] | undefined {
  if (!tabs) {
    return undefined
  }
  let tabIndex = tabIndexByTabs.get(tabs)
  if (!tabIndex) {
    tabIndex = new Map(tabs.map((tab) => [tab.id, tab]))
    tabIndexByTabs.set(tabs, tabIndex)
  }
  return tabIndex.get(tabId)
}

export function useAgentRowConversationName(agent: DashboardAgentRow): string | null {
  const parentPaneKey = agent.entry.orchestration?.parentPaneKey
  const usesParentTab =
    agent.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === agent.tab.id
  const cannotOwnTabName = agent.rowSource === 'subagent' || usesParentTab
  const generatedTitlesEnabled = useAppStateValue(
    (s) => !cannotOwnTabName && s.settings?.tabAutoGenerateTitle === true
  )
  const liveTab = useAppStateValue((s) =>
    cannotOwnTabName
      ? undefined
      : getIndexedTab(s.tabsByWorktree[agent.tab.worktreeId], agent.tab.id)
  )
  const structuredTab = useAppStateValue((s) =>
    cannotOwnTabName
      ? undefined
      : structuredChatTabById(s.unifiedTabsByWorktree, agent.tab.worktreeId, agent.tab.id)
  )
  const conversationName = useStructuredChatTabConversationName(structuredTab)
  // Parse once per render; selectors run on every store write and must stay allocation-free.
  const ownLeafId = cannotOwnTabName ? null : parsePaneKey(agent.paneKey)?.leafId
  // Select this split pane’s primitive title so sibling focus/title changes cannot rename or re-render its row.
  const paneLiveTitle = useAppStateValue((s) =>
    cannotOwnTabName
      ? undefined
      : resolveAgentRowPaneLiveTitle(
          s.terminalLayoutsByTabId?.[agent.tab.id],
          s.runtimePaneTitlesByTabId?.[agent.tab.id],
          ownLeafId
        )
  )
  // Why: synthetic and same-tab child rows do not own the parent tab's name.
  if (cannotOwnTabName) {
    return null
  }
  const structuredName =
    structuredTab &&
    structuredChatDisplayName(structuredTab.customLabel, conversationName, structuredTab.label)
  if (structuredName) {
    return structuredName
  }
  // Why: retained row snapshots need a fallback after their live tab disappears.
  return getAgentRowConversationName(
    liveTab ?? agent.tab,
    agent.agentType,
    generatedTitlesEnabled,
    paneLiveTitle,
    agent.entry.providerSession?.id
  )
}
