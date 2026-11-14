import { describe, expect, it } from 'vitest'
import { makeRun } from '../automations-page-fixtures'
import {
  isAutomationRunNowPending,
  settleAutomationRunNowPending,
  startAutomationRunNowPending
} from './automation-run-now-pending'

const requestedAt = 1_000_000

describe('isAutomationRunNowPending', () => {
  it('stays busy until the run the host returned is listed', () => {
    const pending = {
      requestId: 'req',
      rowKey: 'row',
      requestedAt,
      acknowledgedAt: requestedAt,
      runId: 'new-run'
    }
    expect(isAutomationRunNowPending(pending, 'row', [makeRun({ id: 'old-run' })])).toBe(true)
    expect(isAutomationRunNowPending(pending, 'row', [makeRun({ id: 'new-run' })])).toBe(false)
  })

  it('ignores an earlier same-automation request once a newer one owns the row', () => {
    const older = { requestId: 'r1', rowKey: 'row', requestedAt, acknowledgedAt: null, runId: null }
    const newer = { ...older, requestId: 'r2' }
    const byRow = startAutomationRunNowPending({ row: older }, newer)
    const acknowledged = settleAutomationRunNowPending(byRow, 'row', 'r1', (p) => ({
      ...p,
      acknowledgedAt: requestedAt + 1
    }))
    expect(acknowledged).toBe(byRow)
    expect(
      settleAutomationRunNowPending(byRow, 'row', 'r2', (p) => ({ ...p, acknowledgedAt: 5 }))
    ).toEqual({ row: { ...newer, acknowledgedAt: 5 } })
  })
})
