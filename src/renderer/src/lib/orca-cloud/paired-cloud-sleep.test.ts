// PAIRED-SLEEP: Sleep on a paired cloud workspace puts its sandbox to sleep through the control plane;
// this desktop's own sandboxes keep the ordinary Sleep (their VM suspends), local rows are untouched.
import { afterEach, describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(
  () => new Map<string, { id: string; hostId?: string; isMainWorktree?: boolean }>()
)
const owned = vi.hoisted(() => new Set<string>())
const pairedRegistry = vi.hoisted((): Record<string, string> => ({}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/workspaces/selection/worktree-on-host-selector', () => ({
  getWorktreeOnHostFromState: (_state: unknown, id: string) => rows.get(id)
}))
const refreshStatus = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./orca-cloud-workspace-store', () => ({
  getCloudWorkspaceSnapshot: () => ({ ids: owned, paired: pairedRegistry, status: {} }),
  useIsCloudWorkspace: () => false,
  refreshCloudWorkspaceStatus: refreshStatus
}))

import { isPairedCloudSleepTarget, sleepPairedCloudSandboxes } from './paired-cloud-sleep'
import { resetCloudWorkspaceIdentityForTests } from '@/components/cloud-workspaces/cloud-workspace-identity'

function stub(sleep: (id: string) => Promise<unknown>) {
  const fn = vi.fn(sleep)
  vi.stubGlobal('window', {
    api: {
      cloudWorkspaces: {
        sleep: fn,
        localWorkspaces: async () => [],
        environmentBindings: async () => ({ sbx_paired: { environmentId: 'env-paired' } })
      }
    }
  })
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  rows.clear()
  owned.clear()
  for (const key of Object.keys(pairedRegistry)) {
    delete pairedRegistry[key]
  }
  resetCloudWorkspaceIdentityForTests()
})

describe('PAIRED-SLEEP', () => {
  it('a paired cloud workspace: its sandbox sleeps through the control plane', async () => {
    rows.set('wt-paired', { id: 'wt-paired', hostId: 'runtime:env-paired', isMainWorktree: true })
    const sleep = stub(async () => ({ ok: true, value: undefined }))
    await expect(sleepPairedCloudSandboxes(['wt-paired'])).resolves.toEqual({
      stillRunning: [],
      refused: []
    })
    expect(sleep).toHaveBeenCalledWith('sbx_paired')
    expect(isPairedCloudSleepTarget('wt-paired')).toBe(true)
    // Its row re-reads status at once, so it says Asleep (not Active) and an open wakes it.
    expect(refreshStatus).toHaveBeenCalledWith('wt-paired')
  })

  it('a refused sleep is reported: the sandbox is still running (cloud toast, Try again)', async () => {
    rows.set('wt-paired', { id: 'wt-paired', hostId: 'runtime:env-paired', isMainWorktree: true })
    stub(async () => ({ ok: false, error: 'conflict' }))
    await expect(sleepPairedCloudSandboxes(['wt-paired'])).resolves.toEqual({
      stillRunning: ['wt-paired'],
      refused: []
    })
  })

  it('this desktop’s own sandbox and a local workspace are left to the ordinary Sleep', async () => {
    rows.set('wt-owned', { id: 'wt-owned', hostId: 'runtime:env-paired', isMainWorktree: true })
    owned.add('wt-owned')
    rows.set('wt-local', { id: 'wt-local', hostId: 'local', isMainWorktree: true })
    const sleep = stub(async () => ({ ok: true, value: undefined }))
    await expect(sleepPairedCloudSandboxes(['wt-owned', 'wt-local'])).resolves.toEqual({
      stillRunning: [],
      refused: []
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a non-primary worktree inside a paired sandbox does not sleep the whole sandbox', async () => {
    rows.set('wt-other', { id: 'wt-other', hostId: 'runtime:env-paired', isMainWorktree: false })
    const sleep = stub(async () => ({ ok: true, value: undefined }))
    await sleepPairedCloudSandboxes(['wt-other'])
    expect(sleep).not.toHaveBeenCalled()
  })

  it("a teammate's shared workspace: its registered linked row sleeps the sandbox (SHARED-MEMBER-SLEEP-HANG)", async () => {
    rows.set('wt-linked', { id: 'wt-linked', hostId: 'runtime:env-paired', isMainWorktree: false })
    pairedRegistry['wt-linked'] = 'env-paired'
    const sleep = stub(async () => ({ ok: true, value: undefined }))
    expect(isPairedCloudSleepTarget('wt-linked')).toBe(true)
    await expect(sleepPairedCloudSandboxes(['wt-linked'])).resolves.toEqual({
      stillRunning: [],
      refused: []
    })
    expect(sleep).toHaveBeenCalledWith('sbx_paired')
  })

  it("a member's sleep the control plane refuses is still running and refused, never left pending", async () => {
    rows.set('wt-linked', { id: 'wt-linked', hostId: 'runtime:env-paired', isMainWorktree: false })
    pairedRegistry['wt-linked'] = 'env-paired'
    stub(async () => ({ ok: false, error: 'not_found', status: 404 }))
    await expect(sleepPairedCloudSandboxes(['wt-linked'])).resolves.toEqual({
      stillRunning: ['wt-linked'],
      refused: ['wt-linked']
    })
  })
})
