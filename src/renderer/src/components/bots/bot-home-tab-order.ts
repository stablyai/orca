// Outside React: the order a group's tab bar shows, with the bot's pinned Home first.
import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { findBotByWorkspace } from './bot-workspace'
import { withBotHomeFirstTabIds, type HomeBotLookup } from '../tab-bar/model/pinned-home-tab'

/** The bot whose home `worktreeId` is, asked per tab host as the tab bar asks; none with bots off. */
export function readHomeBotLookup(worktreeId: string): HomeBotLookup {
  if (!readBotsEnabled()) {
    return () => null
  }
  const bots = readBots()
  return (hostId) => findBotByWorkspace(bots, worktreeId, hostId)
}

/**
 * `tabOrder` as the tab bar shows it, for shortcuts, drops and side closes: tabs the stored order misses follow it, as
 * the bar appends them, and the pinned Home leads wherever it is stored (or missing).
 */
export function displayedTabOrder(
  tabOrder: string[],
  groupTabs: readonly Tab[],
  worktreeId: string,
  homeBotFor: HomeBotLookup = readHomeBotLookup(worktreeId)
): string[] {
  const listed = new Set(tabOrder)
  const unlisted = groupTabs.filter((tab) => !listed.has(tab.id)).map((tab) => tab.id)
  return withBotHomeFirstTabIds(
    unlisted.length === 0 ? tabOrder : [...tabOrder, ...unlisted],
    groupTabs,
    homeBotFor
  )
}
