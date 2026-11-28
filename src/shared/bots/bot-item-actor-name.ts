// Who made an item event, as Activity names them: You, the owner or a teammate by name, Orca, the bot,
// the maker, or another agent.
import type { Bot } from '../bot-types'
import type { BotItem, BotItemEvent } from './bot-items'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** `viewer`: the bot as this computer has it; a teammate's copy says who is looking (`shareViewer`). */
export function botItemActorName(
  event: BotItemEvent,
  item: BotItem,
  t: Translate,
  viewer?: Pick<Bot, 'shareViewer'>
): string {
  const you = t('bots.items.activity.you', 'You')
  switch (event.actor.kind) {
    case 'owner': {
      const { person } = event.actor
      const looking = viewer?.shareViewer
      if (person) {
        return person.accountId === looking?.accountId ? you : person.name
      }
      return looking ? (looking.ownerName ?? t('bots.items.filter.owner', 'Owner')) : you
    }
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
