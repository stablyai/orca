import { useState } from 'react'

type BotSidebarPaging = {
  showAllWorkspaces: boolean
  chatSteps: Readonly<Record<string, number>>
  /** The chats folded as older are listed. */
  showOlderChats: boolean
}

const initialPaging: BotSidebarPaging = {
  showAllWorkspaces: false,
  chatSteps: {},
  showOlderChats: false
}
const pagingByBot = new Map<string, BotSidebarPaging>()

export function pruneBotSidebarPaging(liveKeys: ReadonlySet<string>): void {
  for (const key of pagingByBot.keys()) {
    if (!liveKeys.has(key)) {
      pagingByBot.delete(key)
    }
  }
}

/** Keep explicitly expanded pages when scrolling unmounts a bot row. */
export function useBotSidebarPaging(key: string) {
  const [paging, setPaging] = useState(() => pagingByBot.get(key) ?? initialPaging)
  const update = (next: BotSidebarPaging): void => {
    if (next.showAllWorkspaces || next.showOlderChats || Object.keys(next.chatSteps).length > 0) {
      pagingByBot.set(key, next)
    } else {
      pagingByBot.delete(key)
    }
    setPaging(next)
  }
  return {
    ...paging,
    toggleWorkspaces: () => update({ ...paging, showAllWorkspaces: !paging.showAllWorkspaces }),
    toggleOlderChats: () => update({ ...paging, showOlderChats: !paging.showOlderChats }),
    setChatSteps: (chatId: string, count: number) => {
      const chatSteps = { ...paging.chatSteps }
      if (count === 0) {
        delete chatSteps[chatId]
      } else {
        chatSteps[chatId] = count
      }
      update({ ...paging, chatSteps })
    }
  }
}
