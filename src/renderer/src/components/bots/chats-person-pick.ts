// Whose chats the Chats tab lists. Another person's pick is the Home showing their tabs (one view,
// either way in), so leaving that view leaves the pick, back to everyone; the tab itself keeps only
// everyone or the viewer's own. On a host that can't show their tabs, every pick is the tab's own.
import { useState } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import { sameBotPersonPick, type BotChatPersonPick } from '../../../../shared/bots/bot-chat-people'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { tabListPersonOf, useTabListViews, viewedListOfPick } from './teammate-tabs/tab-list-people'
import { sameTabListPerson, useViewedTabList, viewTabList } from './teammate-tabs/viewed-tab-list'

const EVERYONE: BotChatPersonPick = { kind: 'everyone' }

export function useChatsPersonPick(
  bot: Bot,
  entries: readonly { pick: BotChatPersonPick }[] | null
): { pick: BotChatPersonPick; isOwnPick: boolean; setPick: (next: BotChatPersonPick) => void } {
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  const views = useTabListViews(bot)
  const viewedPerson = useViewedTabList(homeKey)?.person ?? null
  const [kept, setKept] = useState<BotChatPersonPick>(EVERYONE)
  const viewedPick =
    views && viewedPerson && entries
      ? (entries.find((entry) => {
          const person = tabListPersonOf(entry.pick)
          return person !== null && sameTabListPerson(person, viewedPerson)
        })?.pick ?? null)
      : null
  // Someone no longer shared with drops the pick back to everyone.
  const keptPick = entries?.some((entry) => sameBotPersonPick(entry.pick, kept)) ? kept : EVERYONE
  const own = entries?.[0]?.pick ?? null
  const pick = viewedPick ?? keptPick
  return {
    pick,
    isOwnPick: own !== null && sameBotPersonPick(pick, own),
    setPick: (next) => {
      if (!views) {
        setKept(next)
        return
      }
      const list = viewedListOfPick(bot, next)
      setKept(list === null ? next : EVERYONE)
      viewTabList(homeKey, list)
    }
  }
}
