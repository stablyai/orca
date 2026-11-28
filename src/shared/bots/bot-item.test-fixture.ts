import type { BotItem } from './bot-items'

/** An open item in Home Chat, numbered `number`, with `fields` over it. */
export function makeTestBotItem(number: number, fields: Partial<BotItem> = {}): BotItem {
  return {
    uid: `uid-${number}`,
    number,
    owner: { botId: 'bot-a', name: 'Bot builder' },
    title: `Item ${number}`,
    description: null,
    doneMeans: null,
    status: 'working',
    chat: { id: 'chat-home', kind: 'home', title: 'Home Chat' },
    madeBy: null,
    question: null,
    closeNote: null,
    wait: null,
    links: [],
    version: 1,
    lastEventId: 'e10',
    othersLastEventId: 'e10',
    snoozedUntil: null,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    ...fields
  }
}
