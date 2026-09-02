import { describe, expect, it } from 'vitest'
import type { AutomationRun } from './automations-types'
import {
  MAX_AUTOMATION_RUNS_PER_AUTOMATION,
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
  it('keeps everything below the cap', () => {
    const runs = makeRuns('a', 5)
    expect(pruneAutomationRuns(runs, 10)).toEqual(runs)
  })

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

  it('preserves original append order among survivors', () => {
    const runs = [...makeRuns('a', 4), ...makeRuns('b', 4)]
    const kept = pruneAutomationRuns(runs, 2)
    expect(kept.map((r) => r.id)).toEqual(['a-2', 'a-3', 'b-2', 'b-3'])
  })

  it('breaks createdAt ties on scheduledFor so pruning is deterministic', () => {
    const runs = [
      run({ id: 'x', automationId: 'a', createdAt: 5, scheduledFor: 1 }),
      run({ id: 'y', automationId: 'a', createdAt: 5, scheduledFor: 2 })
    ]
    expect(pruneAutomationRuns(runs, 1).map((r) => r.id)).toEqual(['y'])
  })

  it('returns nothing when the cap is zero or negative', () => {
    expect(pruneAutomationRuns(makeRuns('a', 3), 0)).toEqual([])
    expect(pruneAutomationRuns(makeRuns('a', 3), -1)).toEqual([])
  })

  // Why: a dispatched run's completion can land hours later; evicting the row
  // would make updateAutomationRun throw 'Automation run not found.'
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

  it('shrinks a realistic runaway history to the cap', () => {
    const runaway = [
      ...makeRuns('a', 2796),
      ...makeRuns('b', 2796),
      ...makeRuns('c', 2796),
      ...makeRuns('d', 2796)
    ]
    expect(runaway).toHaveLength(11_184)
    expect(pruneAutomationRuns(runaway)).toHaveLength(4 * MAX_AUTOMATION_RUNS_PER_AUTOMATION)
  })
})

describe('backfillAutomationRunNumbers', () => {
  it('numbers legacy runs by append position within their automation', () => {
    const runs = [
      run({ id: 'a-0', automationId: 'a' }),
      run({ id: 'b-0', automationId: 'b' }),
      run({ id: 'a-1', automationId: 'a' })
    ]
    expect(backfillAutomationRunNumbers(runs).map((r) => r.runNumber)).toEqual([1, 1, 2])
  })

  it('leaves an existing runNumber untouched', () => {
    const runs = [run({ id: 'a-0', automationId: 'a', runNumber: 42 })]
    expect(backfillAutomationRunNumbers(runs)[0].runNumber).toBe(42)
  })

  // Why: a downgrade to a build that predates `runNumber` appends unnumbered runs
  // after pruned, high-numbered survivors. Numbering by append position reissues a
  // number a survivor still holds, and the two runs end up sharing a title.
  it('never reissues a number a numbered run already holds', () => {
    const runs = [
      run({ id: 'a-0', automationId: 'a', runNumber: 2 }),
      run({ id: 'a-1', automationId: 'a' })
    ]
    const numbers = backfillAutomationRunNumbers(runs).map((r) => r.runNumber)
    expect(numbers).toEqual([2, 3])
    expect(new Set(numbers).size).toBe(numbers.length)
  })

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

  it('falls back to the count for legacy runs with no numbers', () => {
    expect(nextAutomationRunNumber(makeRuns('a', 100))).toBe(101)
  })

  it('starts at 1 for a brand new automation', () => {
    expect(nextAutomationRunNumber([])).toBe(1)
  })

  it('never repeats a number across a prune cycle', () => {
    let runs = backfillAutomationRunNumbers(makeRuns('a', 250))
    runs = pruneAutomationRuns(runs, 100)
    const next = nextAutomationRunNumber(runs)
    expect(next).toBe(251)
    expect(runs.some((r) => r.runNumber === next)).toBe(false)
  })
})
