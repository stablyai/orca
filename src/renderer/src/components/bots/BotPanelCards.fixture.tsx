import { useEffect } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation as automation,
  fixtureChat,
  fixtureCos,
  fixtureSuggestion as suggestion,
  fixtureWorker as worker,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { BotUpNext } from '../../../../shared/bots/bot-look-around'

const now = Date.now()
// The cards, on the bot from the owner's screenshot: its 28 chats, 3 suggestions and schedule.
const min = 60_000
const hour = 3_600_000
const marketing = { ...fixtureCos, name: 'Marketing - X-Manager' }
const ran = (status: 'completed' | 'dispatch_failed' | 'dispatched', ago: number) => ({
  lastRun: { status, at: now - ago }
})
const relay = {
  ...automation('a-relay', 'Check Relay user reply for Nora', 'FREQ=DAILY;BYHOUR=20;BYMINUTE=15', {
    nextRunAt:
      new Date(now).setHours(20, 15, 0, 0) > now
        ? new Date(now).setHours(20, 15, 0, 0)
        : now + 4 * hour
  }),
  ...ran('completed', 11 * min)
}
const MARKETING_CHATS: BotChatTreeChat[] = [
  fixtureChat('home', 'Home Chat', {
    origin: 'home',
    lastActiveAt: now - 3 * min,
    preview: 'I sent CoS a status note that my own runtime is fine.'
  }),
  fixtureChat('relay', 'Check Relay user reply for Nora', {
    origin: 'automation',
    lastActiveAt: now - 11 * min
  }),
  fixtureChat('x1', 'for this https://x.com/i/chat/1670…', {
    lastActiveAt: now - 13 * min,
    preview: 'Set up the checks for 8:15 PM and 10:15 PM to…'
  }),
  fixtureChat('x2', 'research and come up with a good reply plan', {
    lastActiveAt: now - 3 * hour,
    preview: 'Yes! Turn on Browser Use, then choose Settings…'
  }),
  fixtureChat('oc2', 'OpenCode 2 Chat', { lastActiveAt: now - 3 * hour }),
  fixtureChat('x3', 'https://x.com/i/chat/199198144-…', {
    lastActiveAt: now - 3 * hour,
    preview: 'I’d reply: 4 apps in parallel and the usage bar t…'
  }),
  fixtureChat('x4', 'https://x.com/i/chat/20267626444…', {
    lastActiveAt: now - 3 * hour,
    preview: 'You’re right, I linked a related cleanup request in…'
  }),
  fixtureChat('claude', 'Claude Chat', { lastActiveAt: now - 3 * hour }),
  ...Array.from({ length: 20 }, (_, n) =>
    fixtureChat(`old-${n}`, `Older chat ${n + 1}`, { lastActiveAt: now - (n + 1) * 24 * hour })
  )
]
const MARKETING_UP_NEXT: BotUpNext = {
  state: {
    running: false,
    lastLookedAt: now - 18 * min,
    nextAt: now + 3 * hour + 40 * min,
    seenAt: 1
  },
  items: [
    suggestion(
      'm1',
      'Fix the Reshare X post prompt before Thursday',
      'The Reshare X post automation still runs Nov 19 with the old prompt.',
      'https://x.com/home'
    ),
    suggestion(
      'm2',
      'Write my SOUL.md: purpose, voice and limits',
      'SOUL.md still opens with the placeholder line.',
      'https://x.com/home'
    ),
    suggestion(
      'm3',
      'Check which Nov 10-11 X bulk actions landed',
      'The nine exports only record selected likes, replies and reposts.',
      'https://x.com/home'
    )
  ]
}
const TODAY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [relay],
  waits: [],
  upNext: MARKETING_UP_NEXT
}
const daily = (id: string, name: string, h: number, extra: Partial<BotAutomationRow> = {}) => ({
  ...automation(id, name, `FREQ=DAILY;BYHOUR=${h};BYMINUTE=0`, {
    nextRunAt: now + (2 + h / 4) * hour
  }),
  ...ran('completed', (h + 1) * hour),
  ...extra
})
const reshare: BotAutomationRow = {
  ...daily('a-reshare', 'Reshare X post', 14),
  failing: true,
  latestRunId: 'r-reshare',
  ...ran('dispatch_failed', 2 * hour)
}
const mentions: BotAutomationRow = {
  ...daily('a-mentions', 'Mentions triage', 1),
  ...ran('dispatched', 2 * min)
}
const TWELVE: BotActivity = {
  workers: [
    worker('d1', 'Export Nov 10–11 bulk actions', 'blocked'),
    worker('d2', 'Draft replies for @orca_build mentions', 'working')
  ],
  inProgress: [
    {
      kind: 'run',
      key: 'run:r-mentions',
      automationId: 'a-mentions',
      automationName: 'Mentions triage',
      runId: 'r-mentions',
      status: 'dispatched',
      sessionId: null,
      dot: null,
      at: now - 2 * min
    }
  ],
  completed: [],
  automations: [
    relay,
    reshare,
    mentions,
    daily('a-digest-x', 'Daily X digest', 9),
    daily('a-dm', 'DM sweep', 2),
    daily('a-bookmarks', 'Bookmark export', 22),
    daily('a-followers', 'Follower digest', 17),
    daily('a-competitors', 'Competitor launches', 7),
    {
      ...daily('a-queue', 'Reply queue cleanup', 23),
      automation: { ...daily('a-queue', 'Reply queue cleanup', 23).automation, enabled: false }
    },
    {
      ...daily('a-metrics', 'Weekly metrics to #growth', 8),
      automation: {
        ...daily('a-metrics', 'Weekly metrics to #growth', 8).automation,
        enabled: false
      }
    }
  ],
  waits: [],
  upNext: MARKETING_UP_NEXT
}
const NO_AUTOMATIONS: BotActivity = { ...TODAY, automations: [] }

export const cardsToday = defineFixture({
  width: 340,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TODAY, marketing, MARKETING_CHATS),
  render: () => <BotPanelFrame />
})

export const cardsTwelveAutomations = defineFixture({
  width: 340,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TWELVE, marketing, MARKETING_CHATS),
  render: () => <BotPanelFrame />
})

export const cardsNarrow = defineFixture({
  width: 260,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TWELVE, marketing, MARKETING_CHATS),
  render: () => <BotPanelFrame />
})

/** Nothing running at the narrowest width: the Idle line keeps the next time and drops the name. */
export const cardsNarrowIdle = defineFixture({
  width: 260,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TODAY, marketing, MARKETING_CHATS),
  render: () => <BotPanelFrame />
})

export const cardsWide = defineFixture({
  width: 440,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TWELVE, marketing, MARKETING_CHATS),
  render: () => <BotPanelFrame />
})

export const cardsNoAutomationsThreeChats = defineFixture({
  width: 340,
  store: botPanelPage(true, null),
  setup: stubBotPanel(NO_AUTOMATIONS, marketing, MARKETING_CHATS.slice(0, 3)),
  render: () => <BotPanelFrame />
})

/** Look now focused, as a keyboard owner reaches it: it shows where "Ran …" was. */
function FocusLookNow({ children }: { children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    const id = setTimeout(
      () => document.querySelector<HTMLElement>('button[aria-label="Look now"]')?.focus(),
      50
    )
    return () => clearTimeout(id)
  }, [])
  return <>{children}</>
}

export const cardsLookNowFocused = defineFixture({
  width: 340,
  store: botPanelPage(true, null),
  setup: stubBotPanel(TWELVE, marketing, MARKETING_CHATS),
  render: () => (
    <FocusLookNow>
      <BotPanelFrame />
    </FocusLookNow>
  )
})
