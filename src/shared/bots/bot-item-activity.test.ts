import { expect, it } from 'vitest'
import type { BotItemEvent } from './bot-items'
import { makeTestBotItem } from './bot-item.test-fixture'
import { botItemActivity } from './bot-item-activity'

const BOT = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const
const OWNER = { kind: 'owner' } as const

function event(id: string, kind: BotItemEvent['kind'], at: number, data = {}): BotItemEvent {
  return { id, kind, actor: BOT, data, at }
}

function owner(id: string, kind: BotItemEvent['kind'], at: number, data = {}): BotItemEvent {
  return { id, kind, actor: OWNER, data, at }
}

const ASKED = [
  event('e1', 'made', 100, { status: 'planned' }),
  event('e2', 'commented', 200, { text: 'Hold mail while paused?' }),
  event('e3', 'status', 200, { from: 'planned', to: 'needs_you' })
]

it('folds the Needs you move into the question it came with, which waits while open', () => {
  const item = makeTestBotItem(6, { question: { eventId: 'e2', text: 'Hold mail while paused?' } })

  expect(botItemActivity(item, ASKED)).toMatchObject([
    { key: 'e1', kind: 'event' },
    { key: 'e2', kind: 'comment', waiting: true }
  ])
  expect(botItemActivity(makeTestBotItem(6), ASKED)[1]).toMatchObject({ waiting: false })
})

it('keeps a Needs you move that came in its own write', () => {
  const events = [
    event('e2', 'commented', 200, { text: 'Status update' }),
    event('e3', 'status', 900, { from: 'working', to: 'needs_you' })
  ]

  expect(botItemActivity(makeTestBotItem(6), events).map((entry) => entry.key)).toEqual([
    'e2',
    'e3'
  ])
})

it('quotes the question in its reply and drops the move the reply caused, past an early unsnooze', () => {
  const entries = botItemActivity(makeTestBotItem(6), [
    ...ASKED,
    owner('e4', 'commented', 250, { text: 'Hold it.', answers: 'e2' }),
    owner('e5', 'unsnoozed', 250, { early: true }),
    owner('e6', 'status', 250, { from: 'needs_you', to: 'working', cause: 'answer' })
  ])

  expect(entries.map((entry) => entry.key)).toEqual(['e1', 'e2', 'e4', 'e5'])
  expect(entries[2]).toMatchObject({ replyTo: { eventId: 'e2', text: 'Hold mail while paused?' } })
})

it('shows an answer an older host recorded as a reply quoting its question', () => {
  const recorded = {
    text: '1. Hold mail while paused? → Hold it',
    answers: 'e2',
    decisions: [{ picks: [0] }]
  }
  const loaded = botItemActivity(makeTestBotItem(6), [
    ...ASKED,
    owner('e4', 'commented', 250, recorded),
    owner('e5', 'status', 250, { from: 'needs_you', to: 'working', cause: 'answer' })
  ])
  const earlierPage = botItemActivity(makeTestBotItem(6), [
    owner('e9', 'commented', 250, { text: 'Yes', answers: 'e2', asked: '**Ship** it?\n\nMore.' })
  ])

  expect(loaded.map((entry) => entry.key)).toEqual(['e1', 'e2', 'e4'])
  expect(loaded[2]).toMatchObject({ kind: 'comment', replyTo: { eventId: 'e2' } })
  expect(earlierPage).toMatchObject([
    { kind: 'comment', key: 'e9', replyTo: { eventId: 'e2', text: 'Ship it?' } }
  ])
})

it('keeps a question asked while snoozed paired with its own Needs you move', () => {
  const entries = botItemActivity(makeTestBotItem(6), [
    event('e1', 'made', 100, { status: 'planned' }),
    owner('e2', 'snoozed', 150, { until: 900 }),
    event('e3', 'commented', 200, { text: 'Hold mail while paused?' }),
    event('e4', 'unsnoozed', 200, { early: true }),
    event('e5', 'status', 200, { from: 'planned', to: 'needs_you' })
  ])

  expect(entries.map((entry) => entry.key)).toEqual(['e1', 'e2', 'e3', 'e4'])
})

it('keeps each question of an ask waiting until its own reply, a quick reply or the typed one after', () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Ship' }, { label: 'Wait' }] },
      { prompt: 'Tell the team?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  }
  const asked = [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' })
  ]
  const firstReply = [
    owner('e4', 'commented', 250, { text: 'Tell the team? → No', answers: 'e2' }),
    owner('e5', 'status', 250, { from: 'needs_you', to: 'working', cause: 'answer' })
  ]
  const item = makeTestBotItem(6, { status: 'working' })

  const halfway = botItemActivity(item, [...asked, ...firstReply])
  const done = botItemActivity(item, [
    ...asked,
    ...firstReply,
    owner('e6', 'commented', 300, { text: 'Ship it after lunch' })
  ])

  expect(halfway).toMatchObject([
    { key: 'e2', waiting: true, answers: [null, { id: 'e4' }] },
    { key: 'e4', replyTo: { eventId: 'e2', text: 'Tell the team?' } }
  ])
  expect(done).toMatchObject([
    { key: 'e2', waiting: false, answers: [{ id: 'e6' }, { id: 'e4' }] },
    { key: 'e4' },
    { key: 'e6', replyTo: { eventId: 'e2', text: 'Ship it?' } }
  ])
})

it('keeps a quick reply edited before sending with the question it names', () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Ship' }] },
      { prompt: 'Tell the team?', options: [{ label: 'No' }] }
    ]
  }
  const entries = botItemActivity(makeTestBotItem(6, { status: 'working' }), [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    owner('e4', 'commented', 250, { text: 'Tell the team? → No, tell them tomorrow' })
  ])

  expect(entries).toMatchObject([
    { key: 'e2', waiting: true, answers: [null, { id: 'e4' }] },
    { key: 'e4', replyTo: { text: 'Tell the team?' } }
  ])
})
