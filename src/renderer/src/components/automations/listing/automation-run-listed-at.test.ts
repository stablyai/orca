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
  const run = (overrides: Partial<Parameters<typeof getAutomationRunLaunchedAt>[0]>) => ({
    status: 'dispatch_failed' as const,
    dispatchedAt: null,
    startedAt: null,
    chatSessionId: null,
    terminalPaneKey: null,
    ...overrides
  })

  it('is unknown when the chat launcher refused or threw before starting anything', () => {
    // The producer stamps dispatchedAt in its chat catch branch; that is not a launch.
    expect(getAutomationRunLaunchedAt(run({ dispatchedAt: 5 }))).toBeNull()
    expect(
      getAutomationRunLaunchedAt(run({ status: 'skipped_unavailable', dispatchedAt: 5 }))
    ).toBeNull()
  })

  it('is the dispatch time when a run failed after it launched a session or terminal', () => {
    expect(getAutomationRunLaunchedAt(run({ dispatchedAt: 5, chatSessionId: 'chat-1' }))).toBe(5)
    expect(getAutomationRunLaunchedAt(run({ dispatchedAt: 5, terminalPaneKey: 'pane-1' }))).toBe(5)
  })

  it('is the dispatch time of a dispatched or completed run', () => {
    expect(getAutomationRunLaunchedAt(run({ status: 'completed', dispatchedAt: 5 }))).toBe(5)
    expect(getAutomationRunLaunchedAt(run({ status: 'dispatched', dispatchedAt: 5 }))).toBe(5)
  })

  it('is unknown for a skipped or missed run that only carries an observation time', () => {
    expect(getAutomationRunLaunchedAt(run({ status: 'skipped_missed', startedAt: 7 }))).toBeNull()
  })

  it('keeps the start time of older completed records without a dispatch time', () => {
    expect(getAutomationRunLaunchedAt(run({ status: 'completed', startedAt: 7 }))).toBe(7)
  })
})
