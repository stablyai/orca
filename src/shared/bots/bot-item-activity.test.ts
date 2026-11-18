import { expect, it } from 'vitest'
import type { BotItemEvent } from './bot-items'
import { makeTestBotItem } from './bot-item.test-fixture'
import { botItemActivity } from './bot-item-activity'

const BOT = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const

function event(id: string, kind: BotItemEvent['kind'], at: number, data = {}): BotItemEvent {
  return { id, kind, actor: BOT, data, at }
}

const ASKED = [
  event('e1', 'made', 100, { status: 'planned' }),
  event('e2', 'commented', 200, { text: 'Hold mail while paused?' }),
  event('e3', 'status', 200, { from: 'planned', to: 'needs_you' })
]

it('folds the Needs you move into the question it came with', () => {
  const item = makeTestBotItem(6, { question: { eventId: 'e2', text: 'Hold mail while paused?' } })

  expect(botItemActivity(item, ASKED).map((entry) => [entry.key, entry.kind])).toEqual([
    ['e1', 'event'],
    ['e2', 'comment']
  ])
  expect(botItemActivity(item, ASKED)[1]).toMatchObject({ question: 'open' })
})

const OWNER = { kind: 'owner' } as const

function questions(events: BotItemEvent[]): (string | null)[][] {
  return botItemActivity(makeTestBotItem(6), events).flatMap((entry) =>
    entry.kind === 'comment' ? [[entry.key, entry.question]] : []
  )
}

it('marks an earlier question answered only when the owner replied to it', () => {
  const replied = [
    ...ASKED,
    { id: 'e4', kind: 'commented' as const, actor: OWNER, data: { text: 'Hold it.' }, at: 250 },
    event('e5', 'status', 300, { from: 'needs_you', to: 'working' })
  ]

  expect(questions(replied)).toEqual([
    ['e2', 'answered'],
    ['e4', null]
  ])
})

it('never marks a question answered when the bot asked again or moved on without a reply', () => {
  const askedAgain = [
    ...ASKED,
    event('e4', 'commented', 300, { text: 'Or should resume start one turn per chat?' }),
    event('e5', 'status', 300, { from: 'needs_you', to: 'needs_you' })
  ]
  const movedOn = [...ASKED, event('e4', 'status', 300, { from: 'needs_you', to: 'canceled' })]

  expect(questions(askedAgain)).toEqual([
    ['e2', 'asked'],
    ['e4', 'asked']
  ])
  expect(questions(movedOn)).toEqual([['e2', 'asked']])
})

it('keeps a Needs you move that came in its own write', () => {
  const events = [
    event('e2', 'commented', 200, { text: 'Status update' }),
    event('e3', 'status', 900, { from: 'working', to: 'needs_you' })
  ]

  expect(
    botItemActivity(makeTestBotItem(6), events).map((entry) =>
      entry.kind === 'comment' ? [entry.key, entry.question] : [entry.key]
    )
  ).toEqual([['e2', null], ['e3']])
})
