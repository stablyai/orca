// `orca://bot/<botId>?botItem=<uid>`: reads the item, then shows it. Navigation only.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { requestBotItemOpen } from '@/components/bots/items/bot-item-open'
import { showBotItem } from '@/components/bots/items/use-bot-items'
import {
  readBotSettingsPlace,
  setBotSettingsPlace
} from '@/components/bots/settings-view/bot-settings-place'
import type { Bot } from '../../../shared/bot-types'
import type { BotThreadNavigate } from './agent-session/open/bot-thread-open-navigation'
import { openBotHomeTab } from './bot-catalog'
import { botItemLinkCheck } from './bot-item-link-check'

export type PendingBotItemLink = {
  botItemUid: string
  signal: AbortSignal
  navigate: BotThreadNavigate
}

function sayUnreadable(bot: Bot): void {
  toast.info(
    translate('bots.deepLink.itemUnreadable', "Couldn't open that item from {{bot}}.", {
      bot: bot.name
    })
  )
}

export async function openLinkedBotItem(bot: Bot, link: PendingBotItemLink): Promise<void> {
  const { botItemUid, signal, navigate } = link
  const check = await botItemLinkCheck(bot.id, () => showBotItem(bot, botItemUid, { newest: true }))
  if (signal.aborted) {
    return
  }
  if (check === 'missing') {
    toast.info(
      translate('bots.deepLink.itemMissing', "That item isn't on {{bot}}.", { bot: bot.name })
    )
    return
  }
  if (check === 'unreadable') {
    sayUnreadable(bot)
    return
  }
  const opened = await openBotHomeTab(bot, { link: { signal, navigate } }).catch(
    (error: unknown) => {
      console.warn('[bots] opening a linked item failed', error)
      return false
    }
  )
  if (signal.aborted) {
    return
  }
  if (!opened) {
    sayUnreadable(bot)
    return
  }
  // Settings standing in the panel would hide the item.
  if (readBotSettingsPlace('panel')?.botId === bot.id) {
    setBotSettingsPlace('panel', null)
  }
  navigate(() => requestBotItemOpen(bot, botItemUid))
}
