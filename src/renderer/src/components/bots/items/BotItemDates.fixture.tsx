import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemBody } from './BotItemView'

const comment = (id: string, text: string, at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text },
  at
})

const day = (offset: number, hour: number, minute: number): number => {
  const at = new Date()
  at.setDate(at.getDate() + offset)
  at.setHours(hour, minute, 0, 0)
  return at.getTime()
}
const lastYear = new Date(new Date().getFullYear() - 1, 10, 14, 14, 56).getTime()
const bot = { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' } as const
const asked = day(-1, 14, 56)
function Spanning({
  name,
  answered,
  events = spanningEvents
}: {
  name?: string
  answered?: true
  events?: BotItemEvent[]
}): React.JSX.Element {
  const item = makeTestBotItem(41, {
    title: 'Retry flaky upload',
    createdAt: lastYear,
    status: answered ? 'working' : 'needs_you',
    question: answered ? null : { eventId: 'q1', text: 'Should I retry on 503 too?' },
    ...(name
      ? {
          owner: { botId: 'bot-a', name },
          chat: { id: 'c', kind: 'home', title: 'Release planning' }
        }
      : {})
  })
  return (
    <div className="@container flex h-[640px] flex-col">
      <BotItemBody
        bot={fixtureCos}
        item={item}
        view={{
          item,
          events: answered
            ? [
                ...events,
                {
                  id: 'answer',
                  kind: 'commented',
                  actor: { kind: 'owner' },
                  data: { text: 'Retry it.', answers: 'q1' },
                  at: day(0, 10, 0)
                }
              ]
            : events,
          eventsRead: true,
          hasEarlier: false,
          failed: false,
          deleted: false,
          loadEarlier: () => {},
          retry: () => {}
        }}
      />
    </div>
  )
}

const spanningEvents: BotItemEvent[] = [
  { id: 'm1', kind: 'made', actor: bot, data: {}, at: lastYear },
  {
    id: 's1',
    kind: 'status',
    actor: bot,
    data: { from: 'todo', to: 'working' },
    at: day(-12, 9, 10)
  },
  comment('o1', 'The upload still fails sometimes.', day(-1, 10, 44)),
  {
    id: 'q1',
    kind: 'commented',
    actor: bot,
    data: { text: 'Should I retry on 503 too?' },
    at: asked
  },
  { id: 's2', kind: 'status', actor: bot, data: { from: 'working', to: 'needs_you' }, at: asked },
  comment('o2', 'Looking now.', day(0, 9, 5))
]

// Activity spanning last year, this year, yesterday and today, with an open question.
export const days = defineFixture({ width: 420, render: () => <Spanning /> })

// The same in a narrow panel with a long bot name.
export const daysNarrow = defineFixture({
  width: 300,
  render: () => <Spanning name="Release Notes Writer" />
})

export const shortSenderNarrow = defineFixture({
  width: 300,
  render: () => (
    <Spanning
      name="Bot builder"
      events={spanningEvents.map((event) =>
        event.id === 'q1' ? { ...event, at: day(0, 9, 0) } : event
      )}
    />
  )
})

// The narrow pane once the question is answered.
export const daysNarrowAnswered = defineFixture({
  width: 300,
  render: () => <Spanning name="Release Notes Writer" answered />
})
