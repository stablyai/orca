// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toastError: vi.fn(),
  automations: new Array<Automation>(),
  runs: new Array<AutomationRun>(),
  openAutomationsPage: vi.fn()
}))
vi.mock('../automations/hosts/automation-host-client', () => ({
  updateAutomationForTarget: mocks.update
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { botAutomationRows } from '../../../../shared/bots/bot-automation-rows'
import type { Bot } from '../../../../shared/bot-types'
import { BotUpcomingSection } from './BotUpcomingSection'
import { botAutomationCardRows } from './bot-automation-card'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only these fields.
const BOT = {
  id: 'bot-1',
  hostId: 'local',
  name: 'Ranger',
  agent: 'claude',
  folderWorkspaceId: 'fw-1',
  slack: null,
  lookAround: { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' },
  tidyUp: { on: true, every: 'night' }
} as unknown as Bot

const NOW = 1_000_000

function Section(): React.JSX.Element {
  const activity = {
    automations: botAutomationRows(mocks.automations, mocks.runs),
    waits: [],
    inProgress: []
  }
  return (
    <TooltipProvider>
      <BotUpcomingSection
        bot={BOT}
        rows={botAutomationCardRows(BOT, activity, NOW)}
        upNext={undefined}
        hasAutomations={mocks.automations.length > 0}
        signInStops={new Set()}
        now={NOW}
      />
    </TooltipProvider>
  )
}

function failedRun(automationId: string, createdAt: number): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
  return {
    id: `r-${automationId}-${createdAt}`,
    automationId,
    status: 'dispatch_failed',
    createdAt
  } as AutomationRun
}

/** Every row's name button, in order: each has a hover card it is described by. */
const rowTitles = (): string[] =>
  [...document.querySelectorAll('section button[aria-describedby]')].map(
    (node) => node.textContent ?? ''
  )

const shownJobs = (): string[] => rowTitles().filter((title) => title.startsWith('Job'))

/** The named row's Pause or Resume button. */
function rowControl(name: string, action: 'Pause' | 'Resume'): HTMLElement {
  const title = [...document.querySelectorAll('section button[aria-describedby]')].find(
    (node) => node.textContent === name
  )
  if (!title?.parentElement) {
    throw new Error(`No row named ${name}`)
  }
  return within(title.parentElement).getByRole('button', { name: action })
}

function description(button: HTMLElement): string {
  const id = button.getAttribute('aria-describedby')
  return (id && document.getElementById(id)?.textContent) || ''
}

function automation(overrides: Partial<Automation> = {}): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads only the fields set here.
  return {
    id: 'a1',
    name: 'Digest',
    enabled: true,
    nextRunAt: 1,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    updatedAt: 1,
    ...overrides
  } as Automation
}

beforeEach(() => {
  mocks.update.mockReset()
  mocks.toastError.mockReset()
  mocks.openAutomationsPage.mockReset()
  mocks.runs = []
  useAppStore.setState({ openAutomationsPage: mocks.openAutomationsPage })
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('BotUpcomingSection', () => {
  it('shows the saved state at once, before the list re-reads', async () => {
    mocks.automations = [automation()]
    mocks.update.mockResolvedValue(automation({ enabled: false, updatedAt: 2 }))
    render(<Section />)

    await act(async () => {
      fireEvent.click(rowControl('Digest', 'Pause'))
    })

    expect(mocks.update).toHaveBeenCalledWith(automation(), { enabled: false }, { kind: 'local' })
    await waitFor(() => expect(rowControl('Digest', 'Resume')).toHaveProperty('disabled', false))
  })

  it('keeps the old state and says so when saving fails', async () => {
    mocks.automations = [automation()]
    mocks.update.mockRejectedValue(new Error('offline'))
    render(<Section />)

    await act(async () => {
      fireEvent.click(rowControl('Digest', 'Pause'))
    })

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(rowControl('Digest', 'Pause')).toHaveProperty('disabled', false)
  })

  it("says an automation won't run when the bot lacks the connector its events need", () => {
    mocks.automations = [
      automation({
        bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
        dtstart: EVENT_ONLY_SCHEDULE.dtstart,
        on: [{ id: 'e1', source: 'slack', event: 'mentioned' }]
      })
    ]
    render(<Section />)

    const row = screen.getByRole('button', { name: 'Digest, Won’t run' })
    expect(description(row)).toContain('Needs the Slack connector')
  })

  it('keeps a failed automation in place and in the five when paused, until a new run re-ranks', async () => {
    // Job 6 runs last, so only its failure lists it first.
    mocks.automations = [1, 2, 3, 4, 5, 6].map((n) =>
      automation({ id: `a${n}`, name: `Job ${n}`, nextRunAt: NOW + n * 60_000, createdAt: n })
    )
    mocks.runs = [failedRun('a6', 1)]
    mocks.update.mockResolvedValue(automation({ id: 'a6', enabled: false, updatedAt: 2 }))
    const { rerender } = render(<Section />)
    expect(shownJobs()).toEqual(['Job 6', 'Job 1', 'Job 2', 'Job 3', 'Job 4'])

    await act(async () => {
      fireEvent.click(rowControl('Job 6', 'Pause'))
    })
    // The host's next read: paused, so no longer failing.
    mocks.automations = mocks.automations.map((entry) =>
      entry.id === 'a6' ? { ...entry, enabled: false, updatedAt: 2 } : entry
    )
    rerender(<Section />)

    await waitFor(() => expect(rowControl('Job 6', 'Resume')).toBeTruthy())
    expect(shownJobs()).toEqual(['Job 6', 'Job 1', 'Job 2', 'Job 3', 'Job 4'])

    // A real new run still re-ranks: Job 3 fails, and paused Job 6 goes last, past the five.
    mocks.runs = [...mocks.runs, failedRun('a3', 2)]
    rerender(<Section />)
    expect(shownJobs()).toEqual(['Job 3', 'Job 1', 'Job 2', 'Job 4', 'Job 5'])
  })

  it('shows five automations and the built-ins, then a link that counts what the page lists', () => {
    mocks.automations = [1, 2, 3, 4, 5, 6].map((n) =>
      automation({ id: `a${n}`, name: `Job ${n}`, nextRunAt: NOW + n * 60_000, createdAt: n })
    )
    mocks.automations[5] = { ...mocks.automations[5], enabled: false }
    render(<Section />)

    expect(rowTitles()).toEqual([
      'Job 1',
      'Job 2',
      'Job 3',
      'Job 4',
      'Job 5',
      'Tidy memory',
      'Look around'
    ])
    // The rows say what there is; only the link counts.
    expect(screen.getByRole('heading').textContent).toBe('Automations')
    fireEvent.click(screen.getByRole('button', { name: 'All 6 automations · 1 paused' }))
    expect(mocks.openAutomationsPage).toHaveBeenCalledOnce()
  })

  it('keeps a failed automation listed under the folded header, and only it', () => {
    window.localStorage.setItem(
      'orca.bots.panelFolds',
      JSON.stringify({ 'bot-1': ['automations'] })
    )
    mocks.automations = [
      automation({ name: 'Digest', nextRunAt: NOW + 60_000 }),
      automation({ id: 'a2', name: 'Triage', nextRunAt: NOW + 120_000 })
    ]
    mocks.runs = [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
      { id: 'r1', automationId: 'a1', status: 'dispatch_failed', createdAt: 1 } as AutomationRun
    ]
    render(<Section />)

    expect(screen.getByRole('button', { name: 'Automations', expanded: false })).toBeTruthy()
    expect(rowTitles()).toEqual(['Digest'])
    expect(screen.getByRole('button', { name: 'Digest, Failed' })).toBeTruthy()
  })

  it('keeps Look now in the tab order', () => {
    const lookAround = { on: true, every: 'every-4h', weekdaysOnly: true, focus: '' } as const
    const bot: Bot = { ...BOT, lookAround }
    const upNext = { running: false, seenAt: 0, lastLookedAt: NOW - 60_000 }
    render(
      <TooltipProvider>
        <BotUpcomingSection
          bot={bot}
          rows={botAutomationCardRows(
            bot,
            { automations: [], waits: [], inProgress: [], upNext: { state: upNext, items: [] } },
            NOW
          )}
          upNext={upNext}
          hasAutomations={false}
          signInStops={new Set()}
          now={NOW}
        />
      </TooltipProvider>
    )

    const lookNow = screen.getByRole('button', { name: 'Look now' })
    expect(lookNow.getAttribute('tabindex')).not.toBe('-1')
  })
})
