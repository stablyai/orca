// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { UpNextState } from '../../../../shared/bots/bot-look-around'
import { botAutomationCardRows } from './bot-automation-card'
import { UpcomingItem } from './BotUpcomingRows'

// Look around's own reads stand still: whether it is looking is the case under test.
const look = vi.hoisted(() => ({ looking: false }))
vi.mock('./BotUpNextSection', () => ({
  useLooking: () => ({ looking: look.looking, lookNowClicked: () => {} })
}))
vi.mock('./use-bot-usage-limit-stops', () => ({ useBotUsageLimitStops: () => [] }))

// Wed Nov 18 2026, 6:18 PM local; the sweep runs next at 6:30 PM.
const now = new Date(2026, 10, 18, 18, 18).getTime()
const sixThirty = new Date(2026, 10, 18, 18, 30).getTime()
const ninePm = new Date(2026, 10, 18, 21, 0).getTime()

// No connectors: a GitHub event rule is never heard.
const bot: Bot = {
  id: 'bot-triager',
  name: 'Issue Triager',
  hostId: 'local',
  folder: 'triager',
  folderWorkspaceId: 'fw-triager',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-triager',
  createdAt: 1,
  updatedAt: 1
}

const GITHUB_ISSUES = [{ id: 'e1', source: 'github' as const, event: 'issue_opened' as const }]

function automationRow(
  overrides: Partial<BotAutomationRow['automation']> = {},
  row: Partial<BotAutomationRow> = {}
): BotAutomationRow {
  return {
    key: 'a-sweep',
    failing: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields, as the panel fixtures' automations do.
    automation: {
      id: 'a-sweep',
      name: 'GitHub P0 issue sweep',
      enabled: true,
      nextRunAt: sixThirty,
      updatedAt: 1,
      dtstart: now - 86_400_000,
      rrule: 'FREQ=HOURLY;BYMINUTE=30',
      workspaceId: 'fw-triager',
      bot: { botId: bot.id },
      ...overrides
    } as BotAutomationRow['automation'],
    ...row
  }
}

/** The rows as the panel builds them, through the real card builder. */
function cardRows(
  activity: Partial<Pick<BotActivity, 'automations' | 'waits' | 'upNext'>>,
  at = now
): ReturnType<typeof botAutomationCardRows> {
  return botAutomationCardRows(bot, { automations: [], waits: [], inProgress: [], ...activity }, at)
}

function renderRow(key: string, activity: Parameters<typeof cardRows>[0], at = now): void {
  const row = cardRows(activity, at).find((entry) => entry.key === key)
  if (!row) {
    throw new Error(`no row ${key}`)
  }
  render(
    <TooltipProvider>
      <UpcomingItem
        bot={bot}
        row={row}
        upNext={activity.upNext?.state}
        signInStops={new Set()}
        now={at}
        folded={false}
      />
    </TooltipProvider>
  )
}

const SWEEP = 'automation:a-sweep'

beforeEach(() => {
  look.looking = false
})
afterEach(cleanup)

describe('an Automations row says its next run at its end', () => {
  it('shows a scheduled one, named for the screen reader too', () => {
    renderRow(SWEEP, { automations: [automationRow()] })
    expect(screen.getByText('in 12m')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'GitHub P0 issue sweep, next Today at 6:30 PM' })
    ).toBeTruthy()
  })

  it('rolls on with the panel clock', () => {
    renderRow(SWEEP, { automations: [automationRow()] }, now + 5 * 60_000)
    expect(screen.getByText('in 7m')).toBeTruthy()
  })

  it('keeps it on a failed row, after the state', () => {
    renderRow(SWEEP, { automations: [automationRow({}, { failing: true })] })
    expect(screen.getByText('in 12m')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'GitHub P0 issue sweep, Failed, next Today at 6:30 PM' })
    ).toBeTruthy()
  })

  it('keeps it when only its events go unheard: the schedule still runs', () => {
    renderRow(SWEEP, { automations: [automationRow({ on: GITHUB_ISSUES })] })
    expect(screen.getByText('in 12m')).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'GitHub P0 issue sweep, Runs on its schedule only, next Today at 6:30 PM'
      })
    ).toBeTruthy()
  })

  it('says nothing on an event-only row, heard or not', () => {
    renderRow(SWEEP, {
      automations: [
        automationRow({
          dtstart: EVENT_ONLY_SCHEDULE.dtstart,
          rrule: EVENT_ONLY_SCHEDULE.rrule,
          nextRunAt: 0,
          on: GITHUB_ISSUES
        })
      ]
    })
    expect(screen.queryByText(/^in \d+m$/)).toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'GitHub P0 issue sweep, Won’t run'
      })
    ).toBeTruthy()
  })

  it('says nothing on a paused row, nor the word Paused at its end', () => {
    renderRow(SWEEP, { automations: [automationRow({ enabled: false })] })
    expect(screen.queryByText('in 12m')).toBeNull()
    expect(screen.queryByText('Paused')).toBeNull()
    expect(screen.getByRole('button', { name: 'GitHub P0 issue sweep, Paused' })).toBeTruthy()
  })

  it('says nothing on a wait', () => {
    const wait = automationRow({ name: 'Tell me when #40189 merges', once: { by: sixThirty } })
    renderRow('wait:a-sweep', { waits: [wait] })
    expect(screen.queryByText('in 12m')).toBeNull()
    expect(screen.queryByText('6:30 PM')).toBeNull()
  })

  it('says nothing on Tidy memory, whose next run is a window or a wake', () => {
    renderRow('tidy-up', {})
    expect(screen.getByRole('button', { name: 'Tidy memory' })).toBeTruthy()
    expect(
      screen.queryByText(/^[A-Z][a-z]{2} \d{1,2} (AM|PM)$|^\d{1,2}(:\d\d)? (AM|PM)$/)
    ).toBeNull()
  })
})

describe('Look around says only a real next look', () => {
  const upNext = (state: Partial<UpNextState>): BotActivity['upNext'] => ({
    state: { running: false, seenAt: 1, lastLookedAt: now - 3_600_000, ...state },
    items: []
  })

  it('shows its next look', () => {
    renderRow('look-around', { upNext: upNext({ nextAt: ninePm }) })
    expect(screen.getByText('9 PM')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Look around, next Today at 9:00 PM' })).toBeTruthy()
  })

  it('says no time while due, nor once Look now starts before the host answers', () => {
    const due = { upNext: upNext({ dueNow: true }) }
    renderRow('look-around', due)
    expect(screen.getByRole('button', { name: 'Look around' })).toBeTruthy()
    cleanup()
    look.looking = true
    renderRow('look-around', due)
    expect(screen.getByRole('button', { name: 'Look around, Looking around' })).toBeTruthy()
    expect(screen.queryByText(/^in \d+m$/)).toBeNull()
  })
})
