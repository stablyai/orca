import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemActivityList } from './BotItemActivityList'

const AT = new Date(2026, 10, 20, 15, 56).getTime()
const bot = { ...fixtureCos, name: 'Release helper' }
const item = makeTestBotItem(941, {
  title: 'Sign off the migrated UI changes',
  owner: { botId: fixtureCos.id, name: 'Release helper' },
  status: 'working'
})
const by = { kind: 'bot' as const, botId: fixtureCos.id, chatId: 'chat-home' }
const minutes = (n: number): number => AT + n * 60_000

const LONG = [
  'Two more ready for sign-off, no merge requested yet.',
  '',
  'The first keeps the decision context, a recommendation and the option tradeoffs on every owner question. The second shows calendar dates on older activity and keeps the pending tag beside the sender at narrow widths.',
  '',
  'Both passed the code and UX checks before opening, and each carries seeded before and after screenshots. That makes seven changes waiting on you. Approve all seven, or name the ones to change?',
  '',
  'One note: three of them share a base that goes stale tonight, so they need a rebase if still unmerged by then.'
].join('\n')

const events: BotItemEvent[] = [
  { id: 'e1', kind: 'made', actor: by, data: {}, at: minutes(0) },
  { id: 'e2', kind: 'commented', actor: by, data: { text: LONG }, at: minutes(4) },
  {
    id: 'e3',
    kind: 'status',
    actor: by,
    data: { from: 'needs_you', to: 'working' },
    at: minutes(10)
  },
  {
    id: 'e4',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: 'Approve the first two; hold the rest until the rebase lands.' },
    at: minutes(20)
  },
  {
    id: 'e5',
    kind: 'commented',
    actor: by,
    data: {
      text: 'Done: the first two are approved. The rest wait on the rebase; I will post here once it lands.'
    },
    at: minutes(49)
  }
]

// The Activity as it reads on an item: event lines between message cards, one cut at Show more.
function Activity(): React.JSX.Element {
  return (
    <div className="bg-sidebar px-3.5 py-3">
      <BotItemActivityList bot={bot} item={item} events={events} />
    </div>
  )
}

export const narrow = defineFixture({ width: 340, render: () => <Activity /> })
export const wide = defineFixture({ width: 700, render: () => <Activity /> })

// A worker that stopped without a report shows the reason the chat's worker strip shows.
const stoppedItem = makeTestBotItem(1391, {
  title: 'Polish the workers strip',
  owner: { botId: fixtureCos.id, name: 'Release helper' },
  status: 'working',
  links: [
    {
      kind: 'dispatch',
      ref: 'ctx_4ef20e4e6a09',
      latest: null,
      title: 'Workers strip: scroll + legit rows, polish proposals',
      state: 'failed',
      host: null,
      startedAt: minutes(2),
      settledAt: minutes(30),
      report: null,
      reason: 'Agent process lost; its terminal host or session is gone',
      pr: null
    }
  ]
})

export const stoppedWorker = defineFixture({
  width: 420,
  render: () => (
    <div className="bg-sidebar px-3.5 py-3">
      <BotItemActivityList bot={bot} item={stoppedItem} events={events.slice(0, 1)} />
    </div>
  )
})
