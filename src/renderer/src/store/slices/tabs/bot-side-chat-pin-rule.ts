// Only a bot's Home holds the left of its page, so its side chats never pin, whichever path asks.
import { readBots } from '@/lib/bot-catalog-snapshot'
import { botHomeRuleApplies } from '@/lib/bot-host-capability'
import { isBotSideChatTab, isHostedBotChatTab } from '../../../../../shared/bots/bot-home-tab'
import { hostlessChatsAreLocal } from '@/lib/workspace/ownership/recorded-workspace-owner'
import type { RuntimeStatuses } from '../runtime-status/views/runtime-status-subscriptions'
import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'
import { findTabAndWorktree } from './tab-group-state'

/** `pinTab` that leaves a bot's side chat unpinned where its host keeps the rule; unpinning is never refused. */
export function refusingBotSideChats(
  get: TabsSliceGet,
  readStatuses: () => RuntimeStatuses,
  pinTab: TabsSlice['pinTab']
): TabsSlice['pinTab'] {
  return (tabId, opts) => {
    const state = get()
    const tab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)?.tab
    // The tab's own host names its bot, so the same workspace id on two hosts cannot borrow a rule.
    const hostlessAreLocal = tab ? hostlessChatsAreLocal(state, tab.worktreeId) : undefined
    const bot = tab
      ? (readBots().find((candidate) => isHostedBotChatTab(tab, candidate, hostlessAreLocal)) ??
        null)
      : null
    if (
      tab &&
      state.settings?.botsEnabled !== false &&
      isBotSideChatTab(tab, bot, hostlessAreLocal) &&
      botHomeRuleApplies(bot, readStatuses())
    ) {
      return
    }
    pinTab(tabId, opts)
  }
}
