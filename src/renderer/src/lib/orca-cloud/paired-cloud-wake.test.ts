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
import {
  PAIRED_WAKE_MAX_WAIT_MS,
  PAIRED_WAKE_POLL_MS,
  notePairedCloudSlept,
  wakePairedCloudWorkspace,
  wakePairedCloudWorkspaceIfAsleep
} from './paired-cloud-wake'
import { getCloudWorkspaceSnapshot, seedCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { resetCloudWorkspaceIdentityForTests } from '@/components/cloud-workspaces/cloud-workspace-identity'
import type { CloudWorkspaceBinding } from '../../../../preload/api/cloud-workspaces-api'
import {
  captureWakeInput,
  isWorkspaceWaking,
  resetWakeInputForTests
} from '@/components/terminal-pane/input/wake-input-buffer'

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
  // The control plane accepts the wake; the VM then reports running (what the overlay waits for).
  wake = vi.fn(async () => {
    window.api.orcaCloudWorkspace.getStatus = async () => ({
      ok: true as const,
      value: { ...asleep, state: 'ready' as const }
    })
    return { ok: true, value: undefined }
  })
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

  it('holds typing from the press, before the bindings read answers (PAIRED-WAKE-TYPE-THROUGH)', async () => {
    resetWakeInputForTests()
    let answer: (value: Record<string, CloudWorkspaceBinding>) => void = () => undefined
    window.api.cloudWorkspaces.environmentBindings = () =>
      new Promise((resolve) => {
        answer = resolve
      })
    const waking = wakePairedCloudWorkspace(ROW)
    // Still reading the bindings: the first keys typed now are held, not sent to the asleep server.
    expect(isWorkspaceWaking(ROW)).toBe(true)
    expect(
      captureWakeInput(
        ROW,
        'leaf',
        'g',
        () => undefined,
        () => false
      )
    ).toBe(true)
    answer({ sbx_gh: { environmentId: 'env-gh', grantId: null } })
    expect(await waking).toEqual({ ok: true })
    resetWakeInputForTests()
  })

  it('a predictive (quiet) wake holds nothing', async () => {
    resetWakeInputForTests()
    await wakePairedCloudWorkspace(ROW, { quiet: true })
    expect(isWorkspaceWaking(ROW)).toBe(false)
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

describe('the first open right after Sleep (n38 GATE: it sat in "Reconnecting…" instead of waking)', () => {
  it('a cached "ready" from before the Sleep does not stop the wake: the open reads status fresh', async () => {
    // The cache still says running (read moments before Sleep); the server says asleep.
    seedCloudWorkspaceSnapshot({
      paired: { [ROW]: 'env-gh' },
      status: {
        [ROW]: { status: { ...asleep, state: 'ready' }, loading: false, error: null, fetchedAt: 1 }
      }
    })
    const getStatus = vi.fn(async () => ({ ok: true as const, value: asleep }))
    window.api.orcaCloudWorkspace.getStatus = getStatus
    expect(await wakePairedCloudWorkspaceIfAsleep(ROW)).toEqual({ ok: true })
    expect(getStatus).toHaveBeenCalled()
    expect(wake).toHaveBeenCalledWith('sbx_gh')
  })

  it('slept from here and the status read fails: the open still wakes it', async () => {
    seedCloudWorkspaceSnapshot({ paired: { [ROW]: 'env-gh' } })
    window.api.orcaCloudWorkspace.getStatus = async () => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: 'down'
    })
    notePairedCloudSlept(ROW)
    expect(await wakePairedCloudWorkspaceIfAsleep(ROW)).toEqual({ ok: true })
    expect(wake).toHaveBeenCalledWith('sbx_gh')
  })

  it('never slept here and the read fails: it does not guess, nothing wakes', async () => {
    seedCloudWorkspaceSnapshot({ paired: { ['other-row']: 'env-gh' } })
    window.api.orcaCloudWorkspace.getStatus = async () => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: 'down'
    })
    expect(await wakePairedCloudWorkspaceIfAsleep('other-row')).toEqual({ ok: true })
    expect(wake).not.toHaveBeenCalled()
  })
})

describe('the waking overlay for a paired wake (PAIRED-WAKING-OVERLAY)', () => {
  it('stays "waking"/"connecting" until the VM reports running, then ready (not when the request returns)', async () => {
    let polls = 0
    wake.mockImplementationOnce(async () => {
      // Accepted, but the VM takes a moment: asleep on the first read, running on the next.
      window.api.orcaCloudWorkspace.getStatus = async () => {
        polls += 1
        return {
          ok: true as const,
          value: { ...asleep, state: polls > 1 ? ('ready' as const) : ('sleeping' as const) }
        }
      }
      return { ok: true, value: undefined }
    })
    vi.useFakeTimers()
    try {
      const pending = wakePairedCloudWorkspace(ROW)
      await vi.advanceTimersByTimeAsync(0)
      expect(getCloudWorkspaceSnapshot().wake[ROW]?.phase).toBe('connecting')
      await vi.advanceTimersByTimeAsync(PAIRED_WAKE_POLL_MS)
      expect(await pending).toEqual({ ok: true })
      // (The store re-reads once more on "ready".)
      expect(polls).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a VM that never reports running fails the wake (the overlay says so) instead of claiming ready', async () => {
    wake.mockImplementationOnce(async () => ({ ok: true, value: undefined }))
    vi.useFakeTimers()
    try {
      const pending = wakePairedCloudWorkspace(ROW)
      await vi.advanceTimersByTimeAsync(PAIRED_WAKE_MAX_WAIT_MS + PAIRED_WAKE_POLL_MS)
      await pending
      expect(getCloudWorkspaceSnapshot().wake[ROW]?.phase).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })
})
