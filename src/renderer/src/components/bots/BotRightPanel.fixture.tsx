import { defineFixture } from '../../component-fixtures/component-fixture'
import { RightSidebarToggle } from '@/app-shell/chrome/RightSidebarToggle'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation,
  fixtureCos as cos,
  fixtureSuggestion,
  fixtureWorker,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import type { BotActivity, BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import type { AgentDotState } from '../../../../shared/agent-dot-state'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { BotUpNext } from '../../../../shared/bots/bot-look-around'
import { stubUsageLimitFeed } from '../../component-fixtures/fixture-usage-limit-feed'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

const now = Date.now()

const worker = fixtureWorker
const thread = (id: string, title: string, dot: AgentDotState): BotSessionActivityRow => ({
  kind: 'thread',
  key: `thread:${id}`,
  title,
  source: 'slack',
  dot,
  sessionId: id,
  at: now - 10 * 60_000
})
const automation = fixtureAutomation
const tomorrowAt9 = new Date(now + 86_400_000).setHours(9, 0, 0, 0)
const digest = automation(
  'a-digest',
  'Morning standup digest',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  { nextRunAt: tomorrowAt9 }
)
const prReview = automation('a-review', 'PR review', '', {
  dtstart: EVENT_ONLY_SCHEDULE.dtstart,
  rrule: EVENT_ONLY_SCHEDULE.rrule,
  nextRunAt: 0,
  on: [{ id: 'e1', source: 'github', event: 'review_requested' }]
})
const releaseNotes = automation('a-release', 'Friday release notes', 'FREQ=WEEKLY;BYDAY=FR', {
  enabled: false
})
const mergeWait = automation('w-merge', 'Tell me when #40189 merges', '', {
  once: { by: now + 3 * 86_400_000 }
})
const suggestion = fixtureSuggestion
const UP_NEXT: BotUpNext = {
  state: {
    running: false,
    lastLookedAt: now - 40 * 60_000,
    nextAt: now + 2 * 3_600_000,
    seenAt: 1
  },
  items: [
    suggestion(
      's1',
      'Answer Bob’s review on #40167',
      'He asked two questions yesterday. The PR is waiting on you.',
      'https://github.com/stablyai/orca/pull/40167'
    ),
    suggestion(
      's2',
      'Triage 3 new bugs in Triage',
      'Filed since this morning. None has an owner yet.',
      'https://linear.app/globex/issue/ENG-1'
    ),
    suggestion(
      's3',
      'Reply to Nora in #bots',
      'He asked about the relay rollout 2 hours ago.',
      'https://globex.slack.com/archives/C1/p1'
    )
  ]
}
const RECENT: BotSessionActivityRow[] = [
  { ...worker('d9', 'Draft perf notes for Q4', 'done'), at: now - 2 * 60_000 },
  {
    kind: 'run',
    key: 'run:r0',
    automationId: 'a-digest',
    automationName: 'Morning standup digest',
    runId: 'r0',
    status: 'completed',
    sessionId: null,
    dot: null,
    at: now - 5 * 3_600_000
  },
  thread('t9', 'Can you check the relay dashboard?', 'done')
]

const BUSY: BotActivity = {
  workers: [
    worker('d1', 'Fix flaky relay reconnect test', 'working'),
    worker('d2', 'Review #40189 dictation retry', 'working')
  ],
  inProgress: [
    thread('t1', 'Why is CI red on main?', 'working'),
    {
      kind: 'run',
      key: 'run:r-live',
      automationId: 'a-digest',
      automationName: 'Morning standup digest',
      runId: 'r-live',
      status: 'dispatched',
      sessionId: null,
      dot: null,
      at: now - 60_000
    }
  ],
  completed: RECENT,
  automations: [digest, prReview, releaseNotes],
  waits: [mergeWait],
  upNext: UP_NEXT
}
const NEEDS_YOU: BotActivity = {
  workers: [
    worker('d1', 'Fix flaky relay reconnect test', 'blocked'),
    worker('d2', 'Review #40189 dictation retry', 'working')
  ],
  inProgress: [thread('t1', 'Why is CI red on main?', 'working')],
  completed: RECENT,
  automations: [
    digest,
    {
      ...automation('a-linear', 'Label new Linear bugs', 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'),
      failing: true,
      latestRunId: 'r-linear'
    },
    releaseNotes
  ],
  waits: [],
  upNext: UP_NEXT
}
const NEW_BOT: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: [],
  upNext: { state: { running: false, seenAt: 0 }, items: [] }
}
const ALL_PAUSED: BotActivity = {
  workers: [],
  inProgress: [],
  completed: RECENT,
  automations: [
    { ...digest, automation: { ...digest.automation, enabled: false } },
    { ...prReview, automation: { ...prReview.automation, enabled: false } },
    releaseNotes
  ],
  waits: [],
  upNext: { state: { running: false, lastLookedAt: now - 86_400_000, seenAt: 1 }, items: [] }
}

export const busy = defineFixture({
  width: 360,
  store: botPanelPage(true, 'working'),
  setup: stubBotPanel(BUSY),
  render: () => <BotPanelFrame />
})

export const needsYou = defineFixture({
  width: 360,
  store: botPanelPage(true, 'blocked'),
  setup: stubBotPanel(NEEDS_YOU),
  render: () => <BotPanelFrame />
})

export const newBot = defineFixture({
  width: 360,
  store: botPanelPage(true, null),
  setup: stubBotPanel(NEW_BOT),
  render: () => <BotPanelFrame />
})

export const allPaused = defineFixture({
  width: 360,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ALL_PAUSED, {
    ...cos,
    lookAround: { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' },
    tidyUp: { on: false, every: 'night' }
  }),
  render: () => <BotPanelFrame />
})

export const closedWithBadge = defineFixture({
  width: 200,
  store: botPanelPage(false, 'blocked'),
  setup: stubBotPanel(NEEDS_YOU),
  render: () => (
    <div className="flex h-10 items-center justify-end border-b border-border px-2">
      <RightSidebarToggle />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.focus()
  }
})

export const closedWorking = defineFixture({
  width: 200,
  store: botPanelPage(false, 'working'),
  setup: stubBotPanel(BUSY),
  render: () => (
    <div className="flex h-10 items-center justify-end border-b border-border px-2">
      <RightSidebarToggle />
    </div>
  )
})

const LOOK_STOPPED: BotActivity = {
  ...BUSY,
  upNext: {
    state: {
      running: false,
      lastLookedAt: now - 20 * 60_000,
      lastSessionId: 'look-1',
      error: 'The last look didn’t finish.',
      seenAt: 1
    },
    items: []
  }
}

function lookStoppedFixture(auto: boolean) {
  return defineFixture({
    width: 360,
    store: botPanelPage(true, null),
    setup: () => {
      stubBotPanel(LOOK_STOPPED)()
      stubUsageLimitFeed([
        {
          sessionId: 'look-1',
          workspaceId: folderWorkspaceKey(cos.folderWorkspaceId),
          name: 'Look around',
          resetsAt: now + 2 * 3_600_000,
          auto
        }
      ])
    },
    render: () => <BotPanelFrame />
  })
}

export const lookStoppedWaiting = lookStoppedFixture(false)
export const lookStoppedContinues = lookStoppedFixture(true)
