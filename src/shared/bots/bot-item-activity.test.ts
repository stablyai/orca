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

it('links a recorded answer and its question, and drops the move the answer caused', () => {
  const events = [
    event('e1', 'made', 100, { status: 'planned' }),
    event('e2', 'commented', 200, { text: '**Hold mail** while paused?\n\nOr drop it.' }),
    event('e3', 'status', 200, { from: 'planned', to: 'needs_you' }),
    {
      id: 'e4',
      kind: 'commented' as const,
      actor: OWNER,
      data: { text: 'Hold it.', answers: 'e2' },
      at: 250
    },
    {
      id: 'e5',
      kind: 'status' as const,
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ]

  expect(botItemActivity(makeTestBotItem(6), events)).toMatchObject([
    { key: 'e1' },
    { key: 'e2', question: 'answered', answer: { eventId: 'e4', at: 250 } },
    { key: 'e4', question: null, replyTo: { eventId: 'e2', text: 'Hold mail while paused?' } }
  ])
})

it('shows an answer written before answers were recorded as before: inferred, its move kept', () => {
  const entries = botItemActivity(makeTestBotItem(6), [
    ...ASKED,
    { id: 'e4', kind: 'commented' as const, actor: OWNER, data: { text: 'Hold it.' }, at: 250 },
    event('e5', 'status', 300, { from: 'needs_you', to: 'working' })
  ])

  expect(entries.map((entry) => entry.key)).toEqual(['e1', 'e2', 'e4', 'e5'])
  expect(entries[1]).toMatchObject({ question: 'answered' })
  expect(entries[1]).not.toHaveProperty('answer')
  expect(entries[2]).not.toHaveProperty('replyTo')
})

it('keeps the move of an answer whose question is on an earlier page, with no quote', () => {
  const entries = botItemActivity(makeTestBotItem(6), [
    {
      id: 'e4',
      kind: 'commented',
      actor: OWNER,
      data: { text: 'Hold it.', answers: 'e2' },
      at: 250
    },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ])

  expect(entries.map((entry) => entry.key)).toEqual(['e4', 'e5'])
  expect(entries[0]).not.toHaveProperty('replyTo')
})

it("drops an answer's move when an early unsnooze came between them in its write", () => {
  const entries = botItemActivity(makeTestBotItem(6), [
    ...ASKED,
    {
      id: 'e4',
      kind: 'commented',
      actor: OWNER,
      data: { text: 'Hold it.', answers: 'e2' },
      at: 250
    },
    { id: 'e5', kind: 'unsnoozed', actor: OWNER, data: { early: true }, at: 250 },
    {
      id: 'e6',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ])

  expect(entries.map((entry) => entry.key)).toEqual(['e1', 'e2', 'e4', 'e5'])
})

it("starts a follow-up chain's worker once however many of its steps the item links", () => {
  const step = (ref: string) => ({
    kind: 'dispatch' as const,
    ref,
    latest: 'ctx_9',
    title: 'Run one more e2e',
    state: 'working' as const,
    host: null,
    startedAt: 500,
    settledAt: null,
    report: null,
    pr: null
  })
  const item = makeTestBotItem(6, { links: ['ctx_1', 'ctx_3', 'ctx_5', 'ctx_7'].map(step) })

  expect(botItemActivity(item, []).map((entry) => entry.key)).toEqual(['ctx_1:started'])
})
