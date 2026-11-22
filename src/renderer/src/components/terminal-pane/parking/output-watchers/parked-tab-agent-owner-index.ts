/** Agent-owner tab sets for gone-session parking, built once per source identity so a pass over every tab stays linear. */
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

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
