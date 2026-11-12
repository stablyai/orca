import { describe, expect, it } from 'vitest'
import { getAutomationRunListedAt } from '../../../../../shared/automations/history/automation-run'
import { summarizeAutomationRunUsage } from '../../../../../shared/automations/history/automation-usage-summary'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import { getLocalAutomationLastRunSnapshot } from './automation-list-last-run'
import { getAutomationRunLaunchedAt } from '../runs/automation-run-identity-label'

const SLOT = 1_000_000
const LATE_START = SLOT + 95 * 60_000

describe('the time a run is listed under', () => {
  it('is the scheduled slot, even when the run started late', () => {
    const run = makeRun({ scheduledFor: SLOT, dispatchedAt: LATE_START, createdAt: LATE_START })
    expect(getAutomationRunListedAt(run)).toBe(SLOT)
  })

  it('is the latest occurrence for a folded run', () => {
    expect(
      getAutomationRunListedAt({
        scheduledFor: SLOT,
        occurrenceCount: 3,
        lastOccurrenceAt: SLOT + 9
      })
    ).toBe(SLOT + 9)
    expect(getAutomationRunListedAt({ scheduledFor: SLOT, occurrenceCount: 1 })).toBe(SLOT)
  })

  it('is what the list (usage summary) and the detail stat both show', () => {
    const run = makeRun({ scheduledFor: SLOT, dispatchedAt: LATE_START, createdAt: LATE_START })
    expect(summarizeAutomationRunUsage([run]).lastRunListedAt).toBe(SLOT)
    expect(getLocalAutomationLastRunSnapshot(makeAutomation(), run).at).toBe(SLOT)
  })
})

describe('when a run launched', () => {
  it('is its dispatch time', () => {
    expect(
      getAutomationRunLaunchedAt({ status: 'dispatch_failed', dispatchedAt: 5, startedAt: 3 })
    ).toBe(5)
  })

  it('is unknown for a skipped or missed run that only carries an observation time', () => {
    expect(
      getAutomationRunLaunchedAt({ status: 'skipped_missed', dispatchedAt: null, startedAt: 7 })
    ).toBeNull()
    expect(
      getAutomationRunLaunchedAt({ status: 'dispatch_failed', dispatchedAt: null, startedAt: 7 })
    ).toBeNull()
  })

  it('keeps the start time of older completed records without a dispatch time', () => {
    expect(
      getAutomationRunLaunchedAt({ status: 'completed', dispatchedAt: null, startedAt: 7 })
    ).toBe(7)
  })
})
