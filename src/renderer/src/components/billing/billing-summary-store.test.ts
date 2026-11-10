// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import {
  getBillingState,
  getBillingSummary,
  getLastBillingStatus,
  mergeBillingResult,
  recordBillingStatus,
  refreshBillingStatus,
  resetBillingSummary,
  watchBillingStatus
} from './billing-summary-store'
import { sampleTeam } from './plan-billing-fixtures'

const teamA: OrcaBillingStatusResult = { status: 'ok', entitlement: { ...sampleTeam } }
const teamB: OrcaBillingStatusResult = {
  status: 'ok',
  entitlement: { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
}
const offline: OrcaBillingStatusResult = { status: 'failed', error: 'offline' }

let pending: ((result: OrcaBillingStatusResult) => void)[] = []

beforeEach(() => {
  pending = []
  resetBillingSummary()
  vi.stubGlobal('api', {
    orcaProfiles: {
      billingStatus: vi.fn(
        () => new Promise<OrcaBillingStatusResult>((resolve) => pending.push(resolve))
      )
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function answer(index: number, result: OrcaBillingStatusResult): Promise<void> {
  pending[index](result)
  await Promise.resolve()
  await Promise.resolve()
}

describe('mergeBillingResult', () => {
  it('keeps a good answer through a failure and replaces it otherwise', () => {
    expect(mergeBillingResult(teamA, offline)).toBe(teamA)
    expect(mergeBillingResult(null, offline)).toBe(offline)
    expect(mergeBillingResult(teamA, teamB)).toBe(teamB)
    expect(mergeBillingResult(teamA, { status: 'signed-out' })).toEqual({ status: 'signed-out' })
  })
})

describe('billing store', () => {
  it('keeps the last good result when a re-read fails', async () => {
    const read = refreshBillingStatus()
    await answer(0, teamA)
    await read
    expect(getBillingState()).toMatchObject({ result: teamA, loading: false })

    const reread = refreshBillingStatus()
    expect(getBillingState()).toMatchObject({ result: teamA, loading: true })
    await answer(1, offline)
    await reread
    expect(getBillingState()).toMatchObject({ result: teamA, loading: false })
    expect(getLastBillingStatus()).toBe(teamA)
    expect(getBillingSummary()).toMatchObject({ subscribed: true, planLabel: 'Team' })
  })

  it('re-reads after a kept failure instead of trusting it as fresh', async () => {
    recordBillingStatus(teamA)
    recordBillingStatus(offline)
    void refreshBillingStatus({ maxAgeMs: 60_000 })
    expect(pending).toHaveLength(1)
  })

  it('joins a running read and only supersedes it when asked', async () => {
    void refreshBillingStatus()
    void refreshBillingStatus()
    expect(pending).toHaveLength(1)
    void refreshBillingStatus({ supersede: true })
    expect(pending).toHaveLength(2)
    // The older read answers last; the newer one already wrote.
    await answer(1, teamB)
    await answer(0, teamA)
    expect(getBillingState().result).toBe(teamB)
  })

  it('drops an answer that started before a team switch', async () => {
    const read = refreshBillingStatus()
    resetBillingSummary()
    await answer(0, teamA)
    await read
    expect(getBillingState()).toMatchObject({ result: null, loading: false })
    expect(getLastBillingStatus()).toBeNull()
    expect(getBillingSummary().subscribed).toBeNull()
  })

  it("never keeps the previous team's plan through the new team's failed read", async () => {
    recordBillingStatus(teamA)
    resetBillingSummary()
    void refreshBillingStatus()
    await answer(0, offline)
    expect(getBillingState().result).toEqual(offline)
    expect(getLastBillingStatus()).toBeNull()
  })

  it('reads the new team at once when a view is watching through the switch', async () => {
    const release = watchBillingStatus()
    void refreshBillingStatus()
    resetBillingSummary()
    expect(pending).toHaveLength(2)
    expect(getBillingState()).toMatchObject({ result: null, loading: true })
    await answer(0, teamA)
    await answer(1, teamB)
    expect(getBillingState().result).toBe(teamB)
    release()
  })
})
