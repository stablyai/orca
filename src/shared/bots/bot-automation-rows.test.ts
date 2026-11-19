import { describe, expect, it } from 'vitest'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun } from '../automations/history/automation-run'
import { botAutomationFacts, buildBotAutomationRows } from './bot-automation-rows'

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields set here.
  return { id, name: id, enabled: true, nextRunAt: 100, ...overrides } as Automation
}

function run(
  automationId: string,
  status: AutomationRun['status'],
  createdAt: number
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields set here.
  return { id: `${automationId}-${createdAt}`, automationId, status, createdAt } as AutomationRun
}

describe('buildBotAutomationRows', () => {
  it('lists failing automations first, then by next run, then paused ones by name', () => {
    const rows = buildBotAutomationRows(
      [
        automation('soon', { nextRunAt: 10 }),
        automation('zed paused', { enabled: false, nextRunAt: 1 }),
        automation('later', { nextRunAt: 20 }),
        automation('failing', { nextRunAt: 30 }),
        automation('a paused', { enabled: false })
      ],
      [
        run('soon', 'dispatch_failed', 1),
        run('soon', 'completed', 2),
        run('failing', 'dispatch_failed', 3)
      ]
    )

    expect(rows.map((row) => [row.automation.id, row.failing])).toEqual([
      ['failing', true],
      ['soon', false],
      ['later', false],
      ['a paused', false],
      ['zed paused', false]
    ])
  })
})

describe('buildBotAutomationRows lastRun', () => {
  it("carries each automation's newest run and when it ran, paused ones too", () => {
    const rows = buildBotAutomationRows(
      [automation('daily'), automation('paused', { enabled: false }), automation('never')],
      [
        { ...run('daily', 'dispatch_failed', 1), dispatchedAt: 5, startedAt: null },
        { ...run('daily', 'completed', 2), dispatchedAt: 9, startedAt: 8 },
        { ...run('paused', 'completed', 3), dispatchedAt: null, startedAt: 4 }
      ]
    )
    const lastRun = new Map(rows.map((row) => [row.automation.id, row.lastRun]))

    expect(lastRun.get('daily')).toEqual({ status: 'completed', at: 9 })
    expect(lastRun.get('paused')).toEqual({ status: 'completed', at: 4 })
    expect(lastRun.get('never')).toBeUndefined()
  })
})

describe('botAutomationFacts', () => {
  it("lists each event's places by name, never its people or filter text", () => {
    const facts = botAutomationFacts(
      automation('a1', {
        on: [
          {
            id: 'on-1',
            source: 'slack',
            event: 'message',
            in: ['slack:T1:C1'],
            from: ['U1'],
            textContains: 'deploy',
            names: { 'slack:T1:C1': '#orca', U1: 'Nora' }
          }
        ]
      })
    )
    expect(facts.on).toEqual([
      {
        id: 'on-1',
        source: 'slack',
        event: 'message',
        in: ['slack:T1:C1'],
        names: { 'slack:T1:C1': '#orca' }
      }
    ])
  })
})
