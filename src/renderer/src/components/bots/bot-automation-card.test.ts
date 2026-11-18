import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import { botAutomationRows } from '../../../../shared/bots/bot-automation-rows'
import {
  botAutomationCardRows,
  botNextRun,
  botRunningRow,
  rankAutomationCardRows
} from './bot-automation-card'

const NOW = 10_000_000

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
const BOT = {
  id: 'bot-1',
  agent: 'claude',
  lookAround: { on: true, every: 'every-4h', weekdaysOnly: true, focus: '' },
  tidyUp: { on: false, every: 'night' }
} as unknown as Bot

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields set here.
  return {
    id,
    name: id,
    enabled: true,
    nextRunAt: NOW + 60_000,
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    updatedAt: 1,
    createdAt: 1,
    ...overrides
  } as Automation
}

function run(automationId: string, status: AutomationRun['status'], at: number): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields set here.
  return {
    id: `${automationId}-${at}`,
    automationId,
    status,
    createdAt: at,
    dispatchedAt: at,
    startedAt: null
  } as AutomationRun
}

function cardRows(
  automations: Automation[],
  runs: AutomationRun[],
  extra: Partial<Pick<BotActivity, 'inProgress' | 'upNext'>> = {}
) {
  return botAutomationCardRows(
    BOT,
    {
      automations: botAutomationRows(automations, runs),
      waits: [],
      inProgress: extra.inProgress ?? [],
      upNext: extra.upNext ?? { state: { running: false, seenAt: 0 }, items: [] }
    },
    NOW
  )
}

describe('botAutomationCardRows', () => {
  it('ranks failed, then running, then soonest next, then no next, then paused', () => {
    const rows = cardRows(
      [
        automation('later', { nextRunAt: NOW + 5 * 60_000, createdAt: 1 }),
        automation('paused', { enabled: false, nextRunAt: NOW + 1, createdAt: 2 }),
        automation('soon', { nextRunAt: NOW + 60_000, createdAt: 3 }),
        automation('failed', { nextRunAt: NOW + 9 * 60_000, createdAt: 4 }),
        automation('running', { nextRunAt: NOW + 8 * 60_000, createdAt: 5 }),
        automation('overdue', { nextRunAt: NOW - 60_000, createdAt: 6 })
      ],
      [run('failed', 'dispatch_failed', NOW - 1000), run('running', 'dispatched', NOW - 1000)],
      { upNext: { state: { running: false, seenAt: 0, nextAt: NOW + 3 * 60_000 }, items: [] } }
    )

    expect(rankAutomationCardRows(rows).map((row) => row.key)).toEqual([
      'automation:failed',
      'automation:running',
      'automation:soon',
      'look-around',
      'automation:later',
      'automation:overdue',
      'automation:paused',
      'tidy-up'
    ])
  })

  it('never calls a past next run "next" and says how each newest run went', () => {
    const rows = cardRows(
      [
        automation('ran', { nextRunAt: NOW - 60_000 }),
        automation('failed'),
        automation('skipped'),
        automation('paused', { enabled: false }),
        automation('live')
      ],
      [
        run('ran', 'completed', NOW - 3_600_000),
        run('failed', 'dispatch_failed', NOW - 60_000),
        run('skipped', 'skipped_missed', NOW - 60_000),
        run('paused', 'completed', NOW - 60_000)
      ],
      {
        inProgress: [
          {
            kind: 'run',
            key: 'run:live',
            automationId: 'live',
            automationName: 'live',
            runId: 'r-live',
            status: 'dispatched',
            sessionId: null,
            dot: null,
            at: NOW
          }
        ]
      }
    )
    const byKey = new Map(rows.map((row) => [row.key, row]))

    expect(byKey.get('automation:ran')?.nextAt).toBeNull()
    expect(byKey.get('automation:ran')?.mark).toEqual({ kind: 'ran', at: NOW - 3_600_000 })
    expect(byKey.get('automation:failed')?.mark).toEqual({ kind: 'failed' })
    expect(byKey.get('automation:skipped')?.mark).toBeNull()
    expect(byKey.get('automation:paused')?.mark).toBeNull()
    expect(byKey.get('automation:live')?.mark).toEqual({ kind: 'running' })
  })

  it("names the soonest exact next run for the header, skipping Tidy memory's window", () => {
    const rows = cardRows([automation('digest', { nextRunAt: NOW + 7_200_000 })], [], {
      upNext: { state: { running: false, seenAt: 0, nextAt: NOW + 3_600_000 }, items: [] }
    })

    expect(botNextRun(rows)?.key).toBe('look-around')
  })

  it('never names a running automation as next, and gives it to the header as running', () => {
    const rows = cardRows(
      [
        automation('triage', { nextRunAt: NOW + 60_000 }),
        automation('digest', { nextRunAt: NOW + 120_000 })
      ],
      [run('triage', 'dispatched', NOW - 60_000)],
      { upNext: { state: { running: false, seenAt: 0 }, items: [] } }
    )

    const triage = rows.find((row) => row.key === 'automation:triage')
    expect(triage?.mark).toEqual({ kind: 'running' })
    expect(botNextRun(rows)?.key).toBe('automation:digest')
    expect(botRunningRow(rows)?.key).toBe('automation:triage')
  })

  it('has no running row while nothing runs', () => {
    expect(botRunningRow(cardRows([automation('digest')], []))).toBeNull()
  })
})
