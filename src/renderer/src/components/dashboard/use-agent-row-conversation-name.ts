import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
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

/** The row's conversation name, or null when nothing usable exists. */
export function useAgentRowConversationName(agent: DashboardAgentRow): string | null {
  const parentPaneKey = agent.entry.orchestration?.parentPaneKey
  const usesParentTab =
    agent.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === agent.tab.id
  const cannotOwnTabName = agent.rowSource === 'subagent' || usesParentTab
  const generatedTitlesEnabled = useAppStore(
    (s) => !cannotOwnTabName && s.settings?.tabAutoGenerateTitle === true
  )
  const liveTab = useAppStore((s) =>
    cannotOwnTabName
      ? undefined
      : getIndexedTab(s.tabsByWorktree[agent.tab.worktreeId], agent.tab.id)
  )
  // Why: synthetic and same-tab child rows do not own the parent tab's name.
  if (cannotOwnTabName) {
    return null
  }
  // Why: retained row snapshots need a fallback after their live tab disappears.
  return getAgentRowConversationName(liveTab ?? agent.tab, agent.agentType, generatedTitlesEnabled)
}
