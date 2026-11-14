import { describe, expect, it } from 'vitest'
import type { AutomationRun } from './automation-run'
import { backfillAutomationRunNumbers, pruneAutomationRuns } from './automation-run-retention'

function run(overrides: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'automationId'>) {
  return {
    runContext: null,
    sourceContext: null,
    title: overrides.id,
    scheduledFor: 0,
    status: 'skipped_precheck',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0,
    ...overrides
  } as AutomationRun
}

function makeRuns(automationId: string, count: number, from = 0): AutomationRun[] {
  return Array.from({ length: count }, (_, i) =>
    run({ id: `${automationId}-${from + i}`, automationId, createdAt: from + i })
  )
}

describe('pruneAutomationRuns', () => {
  // Dispatched completions may arrive hours later; retain their rows or updateAutomationRun throws.
  it('never evicts in-flight runs, even far past the cap', () => {
    const inFlight = [
      run({ id: 'old-pending', automationId: 'a', status: 'pending', createdAt: -3 }),
      run({ id: 'old-dispatching', automationId: 'a', status: 'dispatching', createdAt: -2 }),
      run({ id: 'old-dispatched', automationId: 'a', status: 'dispatched', createdAt: -1 })
    ]
    const kept = pruneAutomationRuns([...inFlight, ...makeRuns('a', 10)], 3)
    expect(kept.map((r) => r.id)).toEqual([
      'old-pending',
      'old-dispatching',
      'old-dispatched',
      'a-7',
      'a-8',
      'a-9'
    ])
  })
})

describe('backfillAutomationRunNumbers', () => {
  it('numbers unnumbered runs above the highest survivor, per automation', () => {
    const runs = [
      run({ id: 'a-0', automationId: 'a', runNumber: 200 }),
      run({ id: 'b-0', automationId: 'b', runNumber: 7 }),
      run({ id: 'a-1', automationId: 'a' }),
      run({ id: 'b-1', automationId: 'b' })
    ]
    expect(backfillAutomationRunNumbers(runs).map((r) => r.runNumber)).toEqual([200, 7, 201, 8])
  })
})
