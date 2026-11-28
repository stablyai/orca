// Whose chats the Chats tab lists. Another person's pick is the Home showing their tabs (one view,
// either way in), so leaving that view leaves the pick, back to everyone; the tab itself keeps only
// everyone or the viewer's own.
import { useState } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import { sameBotPersonPick, type BotChatPersonPick } from '../../../../shared/bots/bot-chat-people'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { tabListPersonOf, viewedListOfPick } from './teammate-tabs/tab-list-people'
import { sameTabListPerson, useViewedTabList, viewTabList } from './teammate-tabs/viewed-tab-list'

const EVERYONE: BotChatPersonPick = { kind: 'everyone' }

export function useChatsPersonPick(
  bot: Bot,
  entries: readonly { pick: BotChatPersonPick }[] | null
): { pick: BotChatPersonPick; isOwnPick: boolean; setPick: (next: BotChatPersonPick) => void } {
  const homeKey = folderWorkspaceKey(bot.folderWorkspaceId)
  const viewed = useViewedTabList(homeKey)
  const [ownPicked, setOwnPicked] = useState(false)
  const viewedPick =
    viewed && entries
      ? (entries.find((entry) => {
          const person = tabListPersonOf(entry.pick)
          return person !== null && sameTabListPerson(person, viewed.person)
        })?.pick ?? null)
      : null
  const own = entries?.[0]?.pick ?? null
  const pick = viewedPick ?? (ownPicked && own ? own : EVERYONE)
  return {
    pick,
    isOwnPick: own !== null && sameBotPersonPick(pick, own),
    setPick: (next) => {
      const list = viewedListOfPick(bot, next)
      setOwnPicked(list === null && next.kind !== 'everyone')
      viewTabList(homeKey, list)
    }
  }
}
