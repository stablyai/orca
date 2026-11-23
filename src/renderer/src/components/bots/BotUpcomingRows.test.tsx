// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { BotAutomationCardRow } from './bot-automation-card'
import { UpcomingItem } from './BotUpcomingRows'

// Wed Nov 18 2026, 6:18 PM local; the sweep runs next at 6:30 PM.
const now = new Date(2026, 10, 18, 18, 18).getTime()
const sixThirty = new Date(2026, 10, 18, 18, 30).getTime()

const bot = {
  id: 'bot-triager',
  name: 'Issue Triager',
  hostId: 'local',
  folder: 'triager',
  folderWorkspaceId: 'fw-triager',
  agent: 'claude',
  avatar: null,
  paused: false,
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-triager',
  createdAt: 1,
  updatedAt: 1
} as unknown as Bot

function automationRow(
  overrides: Partial<BotAutomationRow['automation']> = {},
  row: Partial<BotAutomationRow> = {}
): BotAutomationRow {
  return {
    key: 'a-sweep',
    failing: false,
    automation: {
      id: 'a-sweep',
      name: 'GitHub P0 issue sweep',
      enabled: true,
      nextRunAt: sixThirty,
      updatedAt: 1,
      dtstart: now - 86_400_000,
      rrule: 'FREQ=HOURLY;BYMINUTE=30',
      workspaceId: 'fw-triager',
      ...overrides
    } as BotAutomationRow['automation'],
    ...row
  }
}

function card(
  row: BotAutomationRow,
  facts: Partial<BotAutomationCardRow> = {},
  kind: 'automation' | 'wait' = 'automation'
): BotAutomationCardRow {
  return {
    kind,
    key: `${kind}:${row.key}`,
    row,
    on: row.automation.enabled,
    failed: row.failing,
    running: false,
    nextAt: row.automation.nextRunAt > now ? row.automation.nextRunAt : null,
    exactNext: true,
    mark: null,
    runFacts: '',
    ...facts
  }
}

function renderRow(row: BotAutomationCardRow, at = now): void {
  render(
    <TooltipProvider>
      <UpcomingItem
        bot={bot}
        row={row}
        upNext={undefined}
        signInStops={new Set()}
        now={at}
        folded={false}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('an Automations row says its next run at its end', () => {
  it('shows a scheduled one, named for the screen reader too', () => {
    renderRow(card(automationRow()))
    expect(screen.getByText('12m', { exact: false }).textContent).toBe('in 12m')
    expect(
      screen.getByRole('button', { name: 'GitHub P0 issue sweep, next Today at 6:30 PM' })
    ).toBeTruthy()
  })

  it('rolls on with the panel clock', () => {
    renderRow(card(automationRow()), now + 5 * 60_000)
    expect(screen.getByText('in 7m')).toBeTruthy()
  })

  it('keeps it on a failed row, after the state', () => {
    renderRow(card(automationRow({}, { failing: true })))
    expect(screen.getByText('in 12m')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'GitHub P0 issue sweep, Failed, next Today at 6:30 PM' })
    ).toBeTruthy()
  })

  it('says nothing on an event-only row', () => {
    const events = automationRow({
      dtstart: EVENT_ONLY_SCHEDULE.dtstart,
      rrule: EVENT_ONLY_SCHEDULE.rrule,
      nextRunAt: 0,
      on: [{ id: 'e1', source: 'github', event: 'issue_opened' }]
    } as Partial<BotAutomationRow['automation']>)
    renderRow(card(events))
    expect(screen.queryByText(/^in \d+m$/)).toBeNull()
    expect(screen.getByRole('button', { name: 'GitHub P0 issue sweep' })).toBeTruthy()
  })

  it('says nothing on a paused row, nor the word Paused at its end', () => {
    renderRow(card(automationRow({ enabled: false }), { nextAt: sixThirty }))
    expect(screen.queryByText('in 12m')).toBeNull()
    expect(screen.queryByText('Paused')).toBeNull()
    expect(screen.getByRole('button', { name: 'GitHub P0 issue sweep, Paused' })).toBeTruthy()
  })

  it('says nothing on a wait', () => {
    const wait = automationRow({ name: 'Tell me when #40189 merges', once: { by: sixThirty } })
    renderRow(card(wait, { nextAt: sixThirty }, 'wait'))
    expect(screen.queryByText('in 12m')).toBeNull()
    expect(screen.queryByText('6:30 PM')).toBeNull()
  })
})
