import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation as automation,
  fixtureCos as cos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'

// Each Automations row says its next run at its end: soon, later today, tomorrow, in the week, later.
// Event-only rows, paused rows and waits say none; hover or Tab into a row and its actions lay over it.
const now = Date.now()
const MINUTE = 60_000
const DAY = 86_400_000
const atHour = (daysOut: number, hour: number, minute = 0): number =>
  new Date(now + daysOut * DAY).setHours(hour, minute, 0, 0)

const sweep = automation('a-sweep', 'GitHub P0 issue sweep', 'FREQ=HOURLY;BYMINUTE=30', {
  nextRunAt: now + 12 * MINUTE
})
const digest = automation('a-digest', 'Morning standup digest', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', {
  nextRunAt: atHour(1, 9)
})
const linear: BotAutomationRow = {
  ...automation('a-linear', 'Label new Linear bugs', 'FREQ=HOURLY;BYMINUTE=0', {
    nextRunAt: now + 2 * 3_600_000
  }),
  failing: true,
  latestRunId: 'r-linear'
}
const mentions = automation('a-mentions', 'Route new GitHub issues', '', {
  dtstart: EVENT_ONLY_SCHEDULE.dtstart,
  rrule: EVENT_ONLY_SCHEDULE.rrule,
  nextRunAt: 0,
  on: [{ id: 'e1', source: 'github', event: 'issue_opened' }]
})
const metrics = automation(
  'a-metrics',
  'Weekly metrics to #growth',
  'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0',
  {
    enabled: false,
    nextRunAt: atHour(4, 8)
  }
)
const release = automation(
  'a-release',
  'Friday release notes',
  'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=30',
  {
    nextRunAt: atHour(3, 16, 30)
  }
)
const monthly = automation(
  'a-monthly',
  'Monthly spend report',
  'FREQ=MONTHLY;BYMONTHDAY=5;BYHOUR=9;BYMINUTE=0',
  {
    nextRunAt: atHour(12, 9)
  }
)
const merge = automation('w-merge', 'Tell me when #40189 merges', '', {
  once: { by: now + 3 * DAY }
})
const longName = (row: BotAutomationRow, name: string): BotAutomationRow => ({
  ...row,
  automation: { ...row.automation, name }
})

const activity = (
  automations: BotAutomationRow[],
  waits: BotAutomationRow[] = []
): BotActivity => ({
  workers: [],
  inProgress: [],
  completed: [],
  automations,
  waits,
  upNext: {
    state: { running: false, lastLookedAt: now - 40 * MINUTE, nextAt: atHour(0, 23), seenAt: 1 },
    items: []
  }
})

const MIXED = activity([sweep, digest, linear, mentions, metrics])
const LATER = activity([release, monthly, mentions], [merge])
const LONG = activity([
  longName(sweep, 'Sweep GitHub for new P0 issues and post a summary to #incidents'),
  longName(linear, 'Label every new Linear bug and route it to the owning team'),
  longName(mentions, 'Route each new GitHub issue to the team that owns its area'),
  longName(metrics, 'Post the weekly growth metrics digest to #growth on Monday')
])

/** Keyboard focus on the row whose name starts with `name`, so its actions show over the time. */
function focusRow(name: string) {
  return async (frame: HTMLElement): Promise<void> => {
    const row = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.getAttribute('aria-label') ?? button.textContent ?? '').startsWith(name)
    )
    row?.focus()
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

function panel(width: number, rows: BotActivity, interact?: (frame: HTMLElement) => Promise<void>) {
  return defineFixture({
    width,
    store: { ...botPanelPage(true, null), rightSidebarWidth: width },
    setup: stubBotPanel(rows, cos),
    render: () => <BotPanelFrame />,
    interact
  })
}

export const mixed240 = panel(240, MIXED)
export const mixed340 = panel(340, MIXED)
export const mixed420 = panel(420, MIXED)
export const later340 = panel(340, LATER)
// A short weekday ("Fri") under a cut name at the narrowest width: the actions lay over its end.
export const laterLong240 = panel(
  240,
  activity(
    [
      longName(release, 'Write the Friday release notes from merged pull requests'),
      longName(monthly, 'Send the monthly spend report to finance'),
      mentions
    ],
    [merge]
  )
)
export const longNames240 = panel(240, LONG)
export const longNames420 = panel(420, LONG)
export const focusedSweep340 = panel(340, MIXED, focusRow('GitHub P0 issue sweep'))
export const focusedFailed240 = panel(240, MIXED, focusRow('Label new Linear bugs'))

// Folded: only the failed row stays, still with its time.
export const folded340 = defineFixture({
  ...panel(340, MIXED),
  setup: () => {
    stubBotPanel(MIXED, cos)()
    window.localStorage.setItem(
      'orca.bots.panelFolds',
      JSON.stringify({ [cos.id]: ['automations'] })
    )
  }
})
