import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import {
  EMPTY_THREAD_IDS,
  useStructuredSessionSummaries
} from '../native-chat/structured-session-summary-store'

export function desktopThreadIds(
  state: { settings?: AppState['settings'] },
  worktreeId: string
): ReadonlySet<string> {
  return state.settings?.experimentalThreads
    ? (useStructuredSessionSummaries.getState().byWorktree.get(worktreeId) ?? EMPTY_THREAD_IDS)
    : EMPTY_THREAD_IDS
}

export function visibleGroupActiveTabId(
  group: TabGroup,
  hidden: ReadonlySet<string>
): string | null {
  if (group.activeTabId && !hidden.has(group.activeTabId)) {
    return group.activeTabId
  }
  return (
    group.recentTabIds?.find((id) => group.tabOrder.includes(id) && !hidden.has(id)) ??
    group.tabOrder.find((id) => !hidden.has(id)) ??
    null
  )
}

export function desktopVisibleTabs(
  state: { settings?: AppState['settings'] },
  worktreeId: string,
  tabs: readonly Tab[]
): readonly Tab[] {
  const hidden = desktopThreadIds(state, worktreeId)
  return hidden.size ? tabs.filter((tab) => !hidden.has(tab.id)) : tabs
}
