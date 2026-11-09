import { describe, expect, it } from 'vitest'
import type { AutomationRun } from './automation-run'
import {
  backfillAutomationRunNumbers,
  nextAutomationRunNumber,
  pruneAutomationRuns
} from './automation-run-retention'

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
  it('keeps only the newest N per automation', () => {
    const kept = pruneAutomationRuns(makeRuns('a', 10), 3)
    expect(kept.map((r) => r.id)).toEqual(['a-7', 'a-8', 'a-9'])
  })

  it('caps each automation independently', () => {
    const runs = [...makeRuns('a', 6), ...makeRuns('b', 2)]
    const kept = pruneAutomationRuns(runs, 3)
    expect(kept.filter((r) => r.automationId === 'a')).toHaveLength(3)
    // 'b' is under the cap and must survive intact.
    expect(kept.filter((r) => r.automationId === 'b')).toHaveLength(2)
  })

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

describe('nextAutomationRunNumber', () => {
  it('continues from the highest surviving run number, not the retained count', () => {
    const retained = [
      run({ id: 'a-0', automationId: 'a', runNumber: 2795 }),
      run({ id: 'a-1', automationId: 'a', runNumber: 2796 })
    ]
    expect(nextAutomationRunNumber(retained)).toBe(2797)
  })
})
