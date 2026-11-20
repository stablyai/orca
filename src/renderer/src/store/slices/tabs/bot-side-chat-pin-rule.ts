// Only a bot's Home holds the left of its page, so its side chats never pin, whichever path asks.
import { readBots } from '@/lib/bot-catalog-snapshot'
import { botOfHomeWorkspace } from '../../../../../shared/bots/bot-homes'
import { isBotSideChatTab } from '../../../../../shared/bots/bot-home-tab'
import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'
import { findTabAndWorktree } from './tab-group-state'

/** `pinTab` that leaves a bot's side chat unpinned; unpinning is never refused. */
export function refusingBotSideChats(
  get: TabsSliceGet,
  pinTab: TabsSlice['pinTab']
): TabsSlice['pinTab'] {
  return (tabId, opts) => {
    const state = get()
    const tab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)?.tab
    const bot = tab ? botOfHomeWorkspace(readBots(), tab.worktreeId) : null
    if (tab && state.settings?.botsEnabled !== false && isBotSideChatTab(tab, bot)) {
      return
    }
    pinTab(tabId, opts)
  }
}
