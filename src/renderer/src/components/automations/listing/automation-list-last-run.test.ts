import { describe, expect, it } from 'vitest'
import { summarizeAutomationRunUsage } from '../../../../../shared/automations/history/automation-usage-summary'
import { makeAutomation, makeAutomationListRow, makeRun } from '../automations-page-fixtures'
import {
  getAutomationRowLastRunSnapshot,
  getLocalAutomationLastRunSnapshot
} from './automation-list-last-run'

const FIRST_OCCURRENCE = Date.UTC(2026, 10, 1, 1, 0)
const LATEST_OCCURRENCE = Date.UTC(2026, 10, 9, 1, 0)

const automation = makeAutomation({ lastRunAt: LATEST_OCCURRENCE })
const foldedRun = makeRun({
  status: 'skipped_unavailable',
  error: 'Execution host is offline.',
  scheduledFor: FIRST_OCCURRENCE,
  createdAt: FIRST_OCCURRENCE,
  startedAt: null,
  dispatchedAt: null,
  occurrenceCount: 9,
  lastOccurrenceAt: LATEST_OCCURRENCE
})

describe('last run time of a folded skipped run', () => {
  it('uses the latest occurrence when the run history is loaded', () => {
    expect(getLocalAutomationLastRunSnapshot(automation, foldedRun).at).toBe(LATEST_OCCURRENCE)
  })

  it('uses the latest occurrence from the projected list summary', () => {
    const row = makeAutomationListRow({
      automation,
      usageSummary: summarizeAutomationRunUsage([foldedRun])
    })
    expect(getAutomationRowLastRunSnapshot(row).at).toBe(LATEST_OCCURRENCE)
  })

  // The list, detail, rail and run tables all name a run by its scheduled slot (UX-I3).
  it('lists a run that never folded at its scheduled slot, not its dispatch time', () => {
    const run = makeRun({
      scheduledFor: FIRST_OCCURRENCE,
      createdAt: FIRST_OCCURRENCE,
      dispatchedAt: FIRST_OCCURRENCE + 95 * 60_000
    })
    expect(getLocalAutomationLastRunSnapshot(automation, run).at).toBe(FIRST_OCCURRENCE)
    const row = makeAutomationListRow({
      automation,
      usageSummary: summarizeAutomationRunUsage([run])
    })
    expect(getAutomationRowLastRunSnapshot(row).at).toBe(FIRST_OCCURRENCE)
  })
})
