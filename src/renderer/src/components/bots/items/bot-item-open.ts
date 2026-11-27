// Opening an item from outside the panel (a chat's item chip): that bot's Items tab shows it. The ask
// names its bot and is taken once, by that bot's panel, however often panels remount.
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { botRefKey, isSameBot, type BotRef } from '@/lib/bot-hosts'
import { openBotHome, readBots } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { botItemLinkedItemName } from '../../../../../shared/bots/bot-item-link-names'
import type { BotItemLinkedItem } from '../../../../../shared/bots/bot-items'
import { findBotByWorkspace } from '../bot-workspace'

type Request = { bot: string; uid: string }

let request: Request | null = null
const listeners = new Set<() => void>()

function announce(): void {
  listeners.forEach((listener) => listener())
}

export function openBotItem(bot: BotRef, uid: string): void {
  request = { bot: botRefKey(bot), uid }
  useAppStore.getState().setRightSidebarTab('bot-activity')
  useAppStore.getState().setRightSidebarOpen(true)
  announce()
}

/** An item another item links (`item:<uid>`): its own bot's Items tab shows it, that bot's home
 *  opening first unless its panel is the one on screen. The two items share a host. */
export function openLinkedBotItem(from: BotRef, item: BotItemLinkedItem, uid: string): void {
  const bots = readBots()
  const owner = bots.find((bot) => bot.id === item.owner.botId && bot.hostId === from.hostId)
  const shown =
    owner && findBotByWorkspace(bots, useAppStore.getState().activeWorktreeId, owner.hostId)
  if (!owner || ((!shown || !isSameBot(shown, owner)) && !openBotHome(owner))) {
    toast.error(
      translate('bots.items.link.itemOpenFailed', "Couldn't open {{item}} yet.", {
        item: botItemLinkedItemName(item)
      })
    )
    return
  }
  openBotItem(owner, uid)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Takes the ask for an item of `bot`, once, and hands its uid to `open`. */
export function useBotItemOpenRequest(bot: BotRef, open: (uid: string) => void): void {
  const pending = useSyncExternalStore(subscribe, () => request)
  const key = botRefKey(bot)
  useEffect(() => {
    if (pending && pending.bot === key && request === pending) {
      request = null
      announce()
      open(pending.uid)
    }
  }, [pending, key, open])
}
