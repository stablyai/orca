// ARCHIVE-MENU-DISABLED: a paired Unarchive whose server is already up when the window opens it starts
// no wake, so nothing settled main's "waking" (source unarchive): the row stayed waking (Archive
// disabled) until the overlay called it stalled. The unarchive now settles it from a fresh read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))
vi.mock('@/components/billing/billing-summary-store', () => ({
  getLastBillingStatus: () => null,
  refreshBillingSummary: async () => undefined
}))
vi.mock('@/lib/worktree-sleep-view', () => ({ isWorktreeSleepViewHeld: () => false }))

import { unarchiveCloudWorkspace } from './orca-cloud-workspace-actions'
import {
  getCloudWorkspaceSnapshot,
  noteCloudWakeProgress,
  seedCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'
import { deriveCloudDotState } from './orca-cloud-workspace-state'

const ROW = 'push-test::/workspace/orca-sandbox-push-test'
const status = (state: 'archived' | 'ready') => ({
  state,
  metrics: null,
  uptimeMs: 0,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
})
const T0 = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  seedCloudWorkspaceSnapshot({
    paired: { [ROW]: 'env-gh' },
    status: { [ROW]: { status: status('archived'), loading: false, error: null, fetchedAt: T0 } },
    idsLoaded: true
  })
  vi.stubGlobal('window', {
    api: {
      orcaCloudWorkspace: {
        // Main's paired unarchive as it was: reports waking, never ready.
        unarchive: async () => {
          noteCloudWakeProgress({
            workspaceId: ROW,
            phase: 'waking',
            source: 'unarchive',
            startedAt: T0,
            at: T0
          })
          return { ok: true, value: null }
        },
        // The control plane brought it up with the unarchive.
        getStatus: async () => ({ ok: true, value: status('ready') })
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  seedCloudWorkspaceSnapshot({})
  vi.useRealTimers()
})

describe('Unarchive of a paired workspace the server already brought up', () => {
  it('settles the wake, so the row is running and Archive is offered again', async () => {
    // The window's open: it reads the status, finds it running, and starts no wake.
    const result = await unarchiveCloudWorkspace(ROW, { wake: async () => undefined })
    expect(result.ok).toBe(true)
    const snapshot = getCloudWorkspaceSnapshot()
    // Settled (it leaves the store once the follow-up read lands).
    expect(snapshot.wake[ROW]?.phase ?? 'ready').toBe('ready')
    expect(snapshot.pending[ROW]).toBeUndefined()
    expect(
      deriveCloudDotState({
        status: snapshot.status[ROW]?.status ?? null,
        wake: snapshot.wake[ROW],
        sleeping: false,
        now: Date.now()
      })
    ).not.toBe('waking')
  })
})
