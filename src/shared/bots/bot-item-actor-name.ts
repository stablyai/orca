// Who made an item event, as Activity names them: You, Orca, or the bot (the maker, when another bot).
import type { BotItem, BotItemEvent } from './bot-items'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botItemActorName(event: BotItemEvent, item: BotItem, t: Translate): string {
  switch (event.actor.kind) {
    case 'owner':
      return t('bots.items.activity.you', 'You')
    case 'orca':
      return 'Orca'
    case 'bot':
      return event.actor.botId === item.madeBy?.botId && item.madeBy.botId !== item.owner.botId
        ? (item.madeBy.name ?? '')
        : (item.owner.name ?? '')
  }
}
