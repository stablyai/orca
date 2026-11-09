/** Agent-owner tab sets for gone-session parking, built once per source identity so a pass over every tab stays linear. */
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

const launchAgentTabIdsByTabs = new WeakMap<readonly TerminalTab[], ReadonlySet<string>>()
const NO_TAB_IDS: ReadonlySet<string> = new Set()

export function launchAgentTabIds(tabs: readonly TerminalTab[] | undefined): ReadonlySet<string> {
  if (!tabs) {
    return NO_TAB_IDS
  }
  let tabIds = launchAgentTabIdsByTabs.get(tabs)
  if (!tabIds) {
    tabIds = new Set(tabs.flatMap((tab) => (tab.launchAgent ? [tab.id] : [])))
    launchAgentTabIdsByTabs.set(tabs, tabIds)
  }
  return tabIds
}

let sleepingRecordTabIdsCache: {
  records: Record<string, SleepingAgentSessionRecord>
  tabIds: ReadonlySet<string>
} | null = null

/** Tabs a sleeping record names by tabId or by a `${tabId}:` pane-key prefix. */
export function sleepingRecordTabIds(
  records: Record<string, SleepingAgentSessionRecord>
): ReadonlySet<string> {
  if (sleepingRecordTabIdsCache?.records === records) {
    return sleepingRecordTabIdsCache.tabIds
  }
  const tabIds = new Set<string>()
  for (const paneKey in records) {
    const recordTabId = records[paneKey]?.tabId
    if (recordTabId !== undefined) {
      tabIds.add(recordTabId)
    }
    for (let colon = paneKey.indexOf(':'); colon !== -1; colon = paneKey.indexOf(':', colon + 1)) {
      tabIds.add(paneKey.slice(0, colon))
    }
  }
  sleepingRecordTabIdsCache = { records, tabIds }
  return tabIds
}
