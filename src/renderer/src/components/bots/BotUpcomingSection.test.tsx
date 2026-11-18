// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toastError: vi.fn(),
  automations: new Array<Automation>(),
  runs: new Array<AutomationRun>(),
  /** A host before rows carried `lastRun`. */
  olderHost: false,
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
    automations: botAutomationRows(mocks.automations, mocks.runs).map((row) =>
      mocks.olderHost ? { ...row, lastRun: undefined } : row
    ),
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

const shownJobs = (): string[] =>
  [...document.querySelectorAll('section button span.font-medium')].flatMap((node) =>
    node.textContent?.startsWith('Job') ? [node.textContent] : []
  )

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
  mocks.olderHost = false
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
      fireEvent.click(screen.getByRole('switch', { name: 'Pause Digest' }))
    })

    expect(mocks.update).toHaveBeenCalledWith(automation(), { enabled: false }, { kind: 'local' })
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Resume Digest' })).toHaveProperty(
        'disabled',
        false
      )
    )
  })

  it('keeps the old state and says so when saving fails', async () => {
    mocks.automations = [automation()]
    mocks.update.mockRejectedValue(new Error('offline'))
    render(<Section />)

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Pause Digest' }))
    })

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(screen.getByRole('switch', { name: 'Pause Digest' })).toHaveProperty('disabled', false)
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

    expect(screen.getByText('Won’t run: needs the Slack connector')).toBeTruthy()
  })

  it('lists soonest first and paused last, and leaves a row in place when its switch flips', async () => {
    mocks.automations = [
      automation({ id: 'b', name: 'Release notes', enabled: false, createdAt: 20 }),
      automation({ id: 'c', name: 'Triage', nextRunAt: NOW + 60_000, createdAt: 30 }),
      automation({ id: 'a', name: 'Digest', nextRunAt: NOW + 120_000, createdAt: 10 })
    ]
    mocks.update.mockResolvedValue(automation({ id: 'c', enabled: false, updatedAt: 2 }))
    const { rerender } = render(<Section />)
    const titles = (): (string | null)[] =>
      [...document.querySelectorAll('section button span.font-medium')].map(
        (node) => node.textContent
      )
    const order = ['Triage', 'Digest', 'Tidy memory', 'Look around', 'Release notes']
    expect(titles()).toEqual(order)

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Pause Triage' }))
    })
    mocks.automations = mocks.automations.map((entry) =>
      entry.id === 'c' ? { ...entry, enabled: false, updatedAt: 2 } : entry
    )
    rerender(<Section />)

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Resume Triage' })).toBeTruthy())
    expect(titles()).toEqual(order)
  })

  it.each([
    ['', false],
    [' on a host before lastRun', true]
  ])(
    'keeps a failed automation in place and in the five when paused, until a new run re-ranks%s',
    async (_, olderHost) => {
      mocks.olderHost = olderHost
      // Job 6 runs last, so only its failure lists it first.
      mocks.automations = [1, 2, 3, 4, 5, 6].map((n) =>
        automation({ id: `a${n}`, name: `Job ${n}`, nextRunAt: NOW + n * 60_000, createdAt: n })
      )
      mocks.runs = [failedRun('a6', 1)]
      mocks.update.mockResolvedValue(automation({ id: 'a6', enabled: false, updatedAt: 2 }))
      const { rerender } = render(<Section />)
      expect(shownJobs()).toEqual(['Job 6', 'Job 1', 'Job 2', 'Job 3', 'Job 4'])

      await act(async () => {
        fireEvent.click(screen.getByRole('switch', { name: 'Pause Job 6' }))
      })
      // The host's next read: paused, so no longer failing.
      mocks.automations = mocks.automations.map((entry) =>
        entry.id === 'a6' ? { ...entry, enabled: false, updatedAt: 2 } : entry
      )
      rerender(<Section />)

      await waitFor(() => expect(screen.getByRole('switch', { name: 'Resume Job 6' })).toBeTruthy())
      expect(shownJobs()).toEqual(['Job 6', 'Job 1', 'Job 2', 'Job 3', 'Job 4'])

      // A real new run still re-ranks: Job 3 fails, and paused Job 6 goes last, past the five.
      mocks.runs = [...mocks.runs, failedRun('a3', 2)]
      rerender(<Section />)
      expect(shownJobs()).toEqual(['Job 3', 'Job 1', 'Job 2', 'Job 4', 'Job 5'])
    }
  )

  it('leaves a failed automation first seen paused in place when resumed, on a host before lastRun', async () => {
    mocks.olderHost = true
    mocks.automations = [1, 2, 3, 4, 5].map((n) =>
      automation({
        id: `a${n}`,
        name: `Job ${n}`,
        nextRunAt: NOW + n * 60_000,
        createdAt: n,
        enabled: n !== 5
      })
    )
    mocks.runs = [failedRun('a5', 1)]
    mocks.update.mockResolvedValue(automation({ id: 'a5', enabled: true, updatedAt: 2 }))
    const { rerender } = render(<Section />)
    const order = ['Job 1', 'Job 2', 'Job 3', 'Job 4', 'Job 5']
    expect(shownJobs()).toEqual(order)

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Resume Job 5' }))
    })
    // The host's next read: on again, and failing from the run before the pause.
    mocks.automations = mocks.automations.map((entry) =>
      entry.id === 'a5' ? { ...entry, enabled: true, updatedAt: 2 } : entry
    )
    rerender(<Section />)

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Pause Job 5' })).toBeTruthy())
    expect(shownJobs()).toEqual(order)
  })

  it('re-ranks on a new failed run of an automation already failing, on a host before lastRun', async () => {
    mocks.olderHost = true
    mocks.automations = [1, 2, 3, 4, 5, 6].map((n) =>
      automation({ id: `a${n}`, name: `Job ${n}`, nextRunAt: NOW + n * 60_000, createdAt: n })
    )
    mocks.runs = [failedRun('a6', 1)]
    mocks.update.mockResolvedValue(automation({ id: 'a1', enabled: false, updatedAt: 2 }))
    const { rerender } = render(<Section />)

    // Pausing Job 1 leaves it in place.
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Pause Job 1' }))
    })
    mocks.automations = mocks.automations.map((entry) =>
      entry.id === 'a1' ? { ...entry, enabled: false, updatedAt: 2 } : entry
    )
    rerender(<Section />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Resume Job 1' })).toBeTruthy())
    expect(shownJobs()).toEqual(['Job 6', 'Job 1', 'Job 2', 'Job 3', 'Job 4'])

    // Job 6 fails again: news, so the card re-ranks and paused Job 1 goes last.
    mocks.runs = [...mocks.runs, failedRun('a6', 2)]
    rerender(<Section />)
    expect(shownJobs()).toEqual(['Job 6', 'Job 2', 'Job 3', 'Job 4', 'Job 5'])
  })

  it('shows five automations and the built-ins, then a link that counts what the page lists', () => {
    mocks.automations = [1, 2, 3, 4, 5, 6].map((n) =>
      automation({ id: `a${n}`, name: `Job ${n}`, nextRunAt: NOW + n * 60_000, createdAt: n })
    )
    mocks.automations[5] = { ...mocks.automations[5], enabled: false }
    render(<Section />)

    expect(screen.getByRole('switch', { name: 'Tidy memory' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Look around' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Resume Job 6' })).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    // The heading counts what the link does, not Tidy memory and Look around.
    expect(screen.getByRole('heading').textContent).toBe('Automations6')
    fireEvent.click(screen.getByRole('button', { name: 'All 6 automations · 1 paused' }))
    expect(mocks.openAutomationsPage).toHaveBeenCalledOnce()
  })

  it('shows a failed automation even when an older Orca saved the card folded', () => {
    window.localStorage.setItem(
      'orca.bots.panelFolds',
      JSON.stringify({ 'bot-1': ['automations'] })
    )
    mocks.automations = [automation({ name: 'Digest', nextRunAt: NOW + 60_000 })]
    mocks.runs = [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
      { id: 'r1', automationId: 'a1', status: 'dispatch_failed', createdAt: 1 } as AutomationRun
    ]
    render(<Section />)

    expect(screen.getByText('Digest')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.queryByRole('button', { expanded: false })).toBeNull()
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
