// PAIRED-WAKE: a paired cloud workspace wakes through the control plane and on intent (focus, hover)
// exactly like an owned one: same candidate rules, quiet when predictive, refusals reported.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))
vi.mock('@/components/billing/billing-summary-store', () => ({
  getLastBillingStatus: () => null,
  refreshBillingSummary: async () => undefined
}))
vi.mock('@/lib/worktree-sleep-view', () => ({ isWorktreeSleepViewHeld: () => false }))

import { isPredictiveWakeCandidate } from './install-cloud-predictive-wake'
import { wakePairedCloudWorkspace, wakePairedCloudWorkspaceIfAsleep } from './paired-cloud-wake'
import { getCloudWorkspaceSnapshot, seedCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { resetCloudWorkspaceIdentityForTests } from '@/components/cloud-workspaces/cloud-workspace-identity'

const ROW = 'push-test::/workspace/orca-sandbox-push-test'
const asleep = {
  state: 'sleeping' as const,
  metrics: null,
  uptimeMs: 0,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
}
const statusEntry = { status: asleep, loading: false, error: null, fetchedAt: 1 }

let wake: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetCloudWorkspaceIdentityForTests()
  seedCloudWorkspaceSnapshot({
    paired: { [ROW]: 'env-gh' },
    status: { [ROW]: statusEntry },
    idsLoaded: true
  })
  wake = vi.fn(async () => ({ ok: true, value: undefined }))
  vi.stubGlobal('window', {
    api: {
      cloudWorkspaces: {
        wake,
        localWorkspaces: async () => [],
        environmentBindings: async () => ({ sbx_gh: { environmentId: 'env-gh' } })
      },
      orcaCloudWorkspace: { getStatus: async () => ({ ok: true, value: asleep }) }
    }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('predictive wake candidates', () => {
  it('a sleeping paired workspace is a candidate, exactly like an owned one', () => {
    expect(isPredictiveWakeCandidate(ROW)).toBe(true)
    seedCloudWorkspaceSnapshot({ ids: new Set(['owned']), status: { owned: statusEntry } })
    expect(isPredictiveWakeCandidate('owned')).toBe(true)
  })

  it('not when it is awake, archived, already waking, or not a cloud workspace at all', () => {
    seedCloudWorkspaceSnapshot({
      paired: { [ROW]: 'env-gh' },
      status: { [ROW]: { ...statusEntry, status: { ...asleep, state: 'ready' } } }
    })
    expect(isPredictiveWakeCandidate(ROW)).toBe(false)
    seedCloudWorkspaceSnapshot({ status: { [ROW]: statusEntry } })
    expect(isPredictiveWakeCandidate(ROW)).toBe(false)
  })
})

describe('waking a paired workspace', () => {
  it('wakes its bound sandbox through the control plane and reports waking, then ready', async () => {
    const result = await wakePairedCloudWorkspace(ROW)
    expect(result).toEqual({ ok: true })
    expect(wake).toHaveBeenCalledWith('sbx_gh')
    // Wake progress never turns it into an owned id (owned-only flows key on those).
    expect(getCloudWorkspaceSnapshot().ids.has(ROW)).toBe(false)
  })

  it('a refusal (billing cap) comes back with its reason, and shows as a failed wake', async () => {
    wake.mockResolvedValueOnce({ ok: false, error: 'Sandbox hours used up', reason: 'quota' })
    const result = await wakePairedCloudWorkspace(ROW)
    expect(result).toEqual({ ok: false, message: 'Sandbox hours used up', reason: 'quota' })
    expect(getCloudWorkspaceSnapshot().wake[ROW]?.phase).toBe('failed')
  })

  it('a plan refusal marks the failed wake as billing, so the card says why (never the code)', async () => {
    wake.mockResolvedValueOnce({
      ok: false,
      error: 'entitlement_denied',
      reason: 'included_hours_exhausted'
    })
    await wakePairedCloudWorkspace(ROW)
    expect(getCloudWorkspaceSnapshot().wake[ROW]?.billingDenial).toEqual({
      reason: 'included_hours_exhausted'
    })
  })

  it('any other refusal is not marked as billing', async () => {
    wake.mockResolvedValueOnce({ ok: false, error: 'Sandbox hours used up', reason: 'quota' })
    await wakePairedCloudWorkspace(ROW)
    expect(getCloudWorkspaceSnapshot().wake[ROW]?.billingDenial).toBeUndefined()
  })

  it('a predictive (quiet) wake that is refused leaves no failed card behind', async () => {
    wake.mockResolvedValueOnce({ ok: false, error: 'Sandbox hours used up', reason: 'quota' })
    expect((await wakePairedCloudWorkspace(ROW, { quiet: true })).ok).toBe(false)
    expect(getCloudWorkspaceSnapshot().wake[ROW]).toBeUndefined()
  })
})

describe('opening a paired workspace (n38 gate: Sleep, then open the row, and it wakes)', () => {
  it('opening an asleep paired row wakes it, with the waking overlay', async () => {
    expect(await wakePairedCloudWorkspaceIfAsleep(ROW)).toEqual({ ok: true })
    expect(wake).toHaveBeenCalledWith('sbx_gh')
    expect(getCloudWorkspaceSnapshot().ids.has(ROW)).toBe(false)
  })

  it('opening a running paired row does not wake anything', async () => {
    const running = { ...asleep, state: 'ready' as const }
    window.api.orcaCloudWorkspace.getStatus = async () => ({ ok: true, value: running })
    seedCloudWorkspaceSnapshot({
      paired: { [ROW]: 'env-gh' },
      status: { [ROW]: { ...statusEntry, status: running } }
    })
    expect(await wakePairedCloudWorkspaceIfAsleep(ROW)).toEqual({ ok: true })
    expect(wake).not.toHaveBeenCalled()
  })

  it('a refused wake on open reports the reason (failure card)', async () => {
    wake.mockResolvedValueOnce({ ok: false, error: 'Sandbox hours used up', reason: 'quota' })
    expect(await wakePairedCloudWorkspaceIfAsleep(ROW)).toEqual({
      ok: false,
      reason: 'Sandbox hours used up'
    })
  })
})
