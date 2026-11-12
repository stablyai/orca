import { describe, expect, it } from 'vitest'
import { makeRun } from '../automations-page-fixtures'
import {
  isAutomationRunNowPending,
  settleAutomationRunNowPending
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

  it('keeps a dispatch in flight busy even if a recent manual run is listed', () => {
    const pending = {
      requestId: 'req',
      rowKey: 'row',
      requestedAt,
      acknowledgedAt: null,
      runId: null
    }
    expect(
      isAutomationRunNowPending(pending, 'row', [
        makeRun({ id: 'previous', trigger: 'manual', createdAt: 999_999 })
      ])
    ).toBe(true)
  })

  it('never blocks Run now because another run is still in progress', () => {
    const stuck = makeRun({ id: 'stuck', status: 'dispatched', createdAt: requestedAt - 3_600_000 })
    expect(isAutomationRunNowPending(null, 'row', [stuck])).toBe(false)
  })

  it('without a returned id, a manual run created after the click ends the wait', () => {
    const pending = {
      requestId: 'req',
      rowKey: 'row',
      requestedAt,
      acknowledgedAt: requestedAt,
      runId: null
    }
    const scheduled = makeRun({ id: 's', trigger: 'scheduled', createdAt: requestedAt + 10 })
    const manual = makeRun({ id: 'm', trigger: 'manual', createdAt: requestedAt + 10 })
    expect(isAutomationRunNowPending(pending, 'row', [scheduled])).toBe(true)
    expect(isAutomationRunNowPending(pending, 'row', [manual])).toBe(false)
  })

  it('only the row that asked shows the busy state', () => {
    const pending = {
      requestId: 'req',
      rowKey: 'row',
      requestedAt,
      acknowledgedAt: requestedAt,
      runId: 'new-run'
    }
    expect(isAutomationRunNowPending(pending, 'other-row', [])).toBe(false)
  })

  it('ignores a late answer to an earlier click that another click replaced', () => {
    const a = { requestId: 'a', rowKey: 'row-a', requestedAt, acknowledgedAt: null, runId: null }
    const b = { requestId: 'b', rowKey: 'row-b', requestedAt, acknowledgedAt: null, runId: null }
    // A fails after B started: B stays busy.
    expect(settleAutomationRunNowPending(b, a.requestId, () => null)).toBe(b)
    // B's own failure clears it.
    expect(settleAutomationRunNowPending(b, b.requestId, () => null)).toBeNull()
  })

  it('ignores an earlier same-automation request once a newer one owns the slot', () => {
    const older = { requestId: 'r1', rowKey: 'row', requestedAt, acknowledgedAt: null, runId: null }
    const newer = { ...older, requestId: 'r2' }
    const acknowledged = settleAutomationRunNowPending(newer, 'r1', (p) => ({
      ...p,
      acknowledgedAt: requestedAt + 1
    }))
    expect(acknowledged).toBe(newer)
  })
})
