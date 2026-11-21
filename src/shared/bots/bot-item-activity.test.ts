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
    {
      key: 'e4',
      answered: { askId: 'e2', lines: [{ index: 1, question: 'Tell the team?', words: 'No' }] }
    }
  ])
  expect(done).toMatchObject([
    { key: 'e2', waiting: false, answers: [{ id: 'e6' }, { id: 'e4' }] },
    { key: 'e4' },
    { key: 'e6', replyTo: { eventId: 'e2', text: 'Ship it?', line: 0 } }
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
    { key: 'e4', answered: { lines: [{ index: 1, words: 'No, tell them tomorrow' }] } }
  ])
})

it('reads one comment answering several questions as the answer to every line it names, each line quoted in order', () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Ship' }, { label: 'Wait' }] },
      { prompt: 'Tell the team?', options: [{ label: 'Yes' }] },
      { prompt: 'Which day?', options: [] }
    ]
  }
  const entries = botItemActivity(makeTestBotItem(6, { status: 'working' }), [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    owner('e4', 'commented', 250, {
      text: 'Ship it? → Wait\nTell the team? → Yes\nWhich day? → Friday',
      answers: 'e2'
    }),
    owner('e5', 'status', 250, { from: 'needs_you', to: 'working', cause: 'answer' })
  ])

  expect(entries).toMatchObject([
    { key: 'e2', waiting: false, answers: [{ id: 'e4' }, { id: 'e4' }, { id: 'e4' }] },
    {
      key: 'e4',
      answered: {
        askId: 'e2',
        total: 3,
        lines: [
          { index: 0, question: 'Ship it?', words: 'Wait' },
          { index: 1, question: 'Tell the team?', words: 'Yes' },
          { index: 2, question: 'Which day?', words: 'Friday' }
        ],
        rest: ''
      }
    }
  ])
})

it("reads answers to an earlier ask's lines, sent after the agent asked again, as that ask's", () => {
  const first = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Ship' }] },
      { prompt: 'Tell the team?', options: [{ label: 'Yes' }] }
    ]
  }
  const again = {
    questions: [
      { prompt: 'Which day?', options: [] },
      { prompt: 'Who reviews?', options: [] }
    ]
  }
  const entries = botItemActivity(
    makeTestBotItem(6, { status: 'needs_you', question: { eventId: 'e5', text: 'copy' } }),
    [
      event('e2', 'commented', 200, { text: 'copy', ask: first }),
      event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
      event('e5', 'commented', 300, { text: 'copy', ask: again }),
      event('e6', 'status', 300, { from: 'needs_you', to: 'needs_you' }),
      owner('e7', 'commented', 400, {
        text: 'Ship it? → Ship\nTell the team? → Yes',
        answers: 'e5'
      })
    ]
  )

  expect(entries.find((entry) => entry.key === 'e5')).toMatchObject({ answers: [null, null] })
  expect(entries.find((entry) => entry.key === 'e2')).toMatchObject({
    answers: [{ id: 'e7' }, { id: 'e7' }]
  })
  expect(entries.find((entry) => entry.key === 'e7')).toMatchObject({
    answered: { askId: 'e2', lines: [{ index: 0 }, { index: 1 }] }
  })
})

it('gives a line a plain comment took by order to the comment that later names it', () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Ship' }] },
      { prompt: 'Tell the team?', options: [{ label: 'Yes' }] }
    ]
  }
  const entries = botItemActivity(makeTestBotItem(6, { status: 'working' }), [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    owner('e4', 'commented', 250, { text: 'let me check with legal' }),
    owner('e5', 'commented', 300, { text: 'Ship it? → Ship\nTell the team? → Yes' })
  ])

  expect(entries).toMatchObject([
    { key: 'e2', waiting: false, answers: [{ id: 'e5' }, { id: 'e5' }] },
    { key: 'e4' },
    { key: 'e5', answered: { lines: [{ index: 0 }, { index: 1 }] } }
  ])
  expect(entries[1]).not.toHaveProperty('answered')
})

it('reads a held answer by the question it names, with or without a question mark', () => {
  const first = { questions: [{ prompt: 'Deployment region', options: [{ label: 'EU' }] }] }
  const again = { questions: [{ prompt: 'Ship it?', options: [{ label: 'Ship' }] }] }
  const asks = [
    event('e2', 'commented', 200, { text: 'copy', ask: first }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    event('e5', 'commented', 300, { text: 'copy', ask: again }),
    event('e6', 'status', 300, { from: 'needs_you', to: 'needs_you' })
  ]
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e5', text: 'copy' }
  })

  const earlier = botItemActivity(item, [
    ...asks,
    owner('e7', 'commented', 400, { text: 'Deployment region → US' })
  ])
  const named = botItemActivity(item, [
    ...asks,
    owner('e7', 'commented', 400, { text: 'Ship it? → After legal review' })
  ])

  expect(earlier.find((entry) => entry.key === 'e5')).toMatchObject({ answers: [null] })
  expect(named.find((entry) => entry.key === 'e5')).toMatchObject({ answers: [{ id: 'e7' }] })
})

it('quotes each line an answer gives, its image marks kept on their own line, and its own words after', () => {
  const ask = {
    questions: [
      { prompt: 'Fix Datadog?', options: [{ label: 'Yes' }] },
      { prompt: 'Vercel: test it?', options: [{ label: 'Test it' }] },
      { prompt: 'GitLab host field?', options: [{ label: 'Later' }] }
    ]
  }
  const entries = botItemActivity(makeTestBotItem(6, { status: 'working' }), [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    owner('e4', 'commented', 250, {
      text: 'Fix Datadog? → what do others do\nVercel: test it? → sign in works [Image #1]\nalso, ping me',
      images: [{ path: '/store/shot.png', name: 'shot.png', bytes: 70 }]
    })
  ])

  expect(entries[1]).toMatchObject({
    key: 'e4',
    answered: {
      lines: [
        { index: 0, question: 'Fix Datadog?', words: 'what do others do' },
        { index: 1, question: 'Vercel: test it?', words: 'sign in works [Image #1]' }
      ],
      rest: 'also, ping me'
    }
  })
  // The phone quotes the line its image is on.
  expect(entries[1]).toMatchObject({
    replyTo: { eventId: 'e2', text: 'Vercel: test it?', line: 1 }
  })
})

it('keeps a second line for the same question in the words, as the correction the agent read', () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [] },
      { prompt: 'Which day?', options: [] }
    ]
  }
  const entries = botItemActivity(makeTestBotItem(6, { status: 'working' }), [
    event('e2', 'commented', 200, { text: 'copy', ask }),
    event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
    owner('e4', 'commented', 250, { text: 'Which day? → Friday\nWhich day? → Monday, sorry' })
  ])

  expect(entries[1]).toMatchObject({
    answered: { lines: [{ index: 1, words: 'Friday' }], rest: 'Which day? → Monday, sorry' }
  })
})

it('reads questions that start the same way by their number, and in order where unnumbered', () => {
  const ask = {
    questions: [
      { prompt: 'Theme?\nDesktop', options: [] },
      { prompt: 'Theme?\nPhone', options: [] }
    ]
  }
  const read = (text: string) =>
    botItemActivity(makeTestBotItem(6, { status: 'working' }), [
      event('e2', 'commented', 200, { text: 'copy', ask }),
      event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
      owner('e4', 'commented', 250, { text })
    ])[1]

  expect(read('2. Theme? → dark')).toMatchObject({
    answered: { lines: [{ index: 1, words: 'dark' }] }
  })
  expect(read('Theme? → light\nTheme? → dark')).toMatchObject({
    answered: {
      lines: [
        { index: 0, words: 'light' },
        { index: 1, words: 'dark' }
      ]
    }
  })
})

it('pairs a comment still on its way as the answer to its lines, and lists it last', () => {
  const ask = {
    questions: [
      { prompt: 'Fix Datadog?', options: [{ label: 'Yes' }] },
      { prompt: 'Vercel: test it?', options: [{ label: 'Test it' }] }
    ]
  }
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'copy' }
  })
  const sent = owner('pending:1', 'commented', 999, { text: 'Fix Datadog? → Yes' })
  const entries = botItemActivity(
    item,
    [
      event('e2', 'commented', 200, { text: 'copy', ask }),
      event('e3', 'status', 200, { from: 'working', to: 'needs_you' }),
      event('e4', 'edited', 1500, { fields: {} })
    ],
    [sent]
  )

  expect(entries.map((entry) => entry.key)).toEqual(['e2', 'e4', 'pending:1'])
  expect(entries[0]).toMatchObject({ waiting: true, answers: [{ id: 'pending:1' }, null] })
  expect(entries[2]).toMatchObject({ answered: { lines: [{ index: 0, words: 'Yes' }] } })
})
