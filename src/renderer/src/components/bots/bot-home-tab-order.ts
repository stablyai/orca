// Outside React: the order a group's tab bar shows, with the bot's pinned Home first.
import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { findBotByWorkspace } from './bot-workspace'
import { withBotHomeFirstTabIds, type HomeBotLookup } from '../tab-bar/model/pinned-home-tab'

/**
 * The bot whose home `worktreeId` is, asked per tab host; null when no bot on any host calls it home, so the strip
 * skips the Home search outright.
 */
export function homeBotLookupFor(bots: readonly Bot[], worktreeId: string): HomeBotLookup | null {
  // Why the host-free lookup decides: every bot is indexed by its home alone as well as by host and home.
  if (findBotByWorkspace(bots, worktreeId) === null) {
    return null
  }
  return (hostId) => findBotByWorkspace(bots, worktreeId, hostId)
}

/** `homeBotLookupFor` on the catalog, as the tab bar reads it; none with bots off. */
export function readHomeBotLookup(worktreeId: string): HomeBotLookup | null {
  return readBotsEnabled() ? homeBotLookupFor(readBots(), worktreeId) : null
}

/**
 * `tabOrder` as the tab bar shows it, for shortcuts, drops and side closes: tabs the stored order misses follow it, as
 * the bar appends them, and the pinned Home leads wherever it is stored (or missing).
 */
export function displayedTabOrder(
  tabOrder: string[],
  groupTabs: readonly Tab[],
  worktreeId: string,
  homeBotFor: HomeBotLookup | null = readHomeBotLookup(worktreeId)
): string[] {
  const listed = new Set(tabOrder)
  const unlisted = groupTabs.filter((tab) => !listed.has(tab.id)).map((tab) => tab.id)
  return withBotHomeFirstTabIds(
    unlisted.length === 0 ? tabOrder : [...tabOrder, ...unlisted],
    groupTabs,
    homeBotFor
  )
}
