// Who made an item event, as Activity names them: You, Orca, the bot, the maker, or another agent.
import type { BotItem, BotItemEvent } from './bot-items'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botItemActorName(event: BotItemEvent, item: BotItem, t: Translate): string {
  switch (event.actor.kind) {
    case 'owner':
      return t('bots.items.activity.you', 'You')
    case 'orca':
      return 'Orca'
    case 'bot':
      if (event.actor.botId === item.owner.botId) {
        return item.owner.name ?? ''
      }
      return event.actor.botId === item.madeBy?.botId
        ? (item.madeBy.name ?? '')
        : t('bots.items.activity.anotherAgent', 'Another agent')
  }
}
