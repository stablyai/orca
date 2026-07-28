import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: vi.fn()
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: () => 'host-tab-1'
}))

import { closeWebRuntimeSessionTab } from './web-runtime-session'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('returns close proof without waiting for the post-close snapshot refresh', async () => {
  let resolveList!: (value: unknown) => void
  const pendingList = new Promise((resolve) => {
    resolveList = resolve
  })
  const runtimeCall = vi.fn(({ method }: { method: string }) =>
    method === 'session.tabs.close'
      ? Promise.resolve({
          id: 'close',
          ok: true,
          result: { closed: true },
          _meta: { runtimeId: 'runtime-1' }
        })
      : pendingList
  )
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: runtimeCall } }
  })
  mocks.getState.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: 'env-close-refresh' }
  })
  let outcome = 'pending'
  const observed = closeWebRuntimeSessionTab({
    environmentId: 'env-close-refresh',
    worktreeId: 'repo::/worktree',
    tabId: 'local-tab-1',
    reason: 'user'
  }).then((result) => {
    outcome = result ? 'closed' : 'failed'
  })

  await vi.waitFor(() =>
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.list' })
    )
  )
  const outcomeBeforeList = outcome
  resolveList({
    id: 'list',
    ok: true,
    result: {
      worktree: 'repo::/worktree',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  await observed

  expect(outcomeBeforeList).toBe('closed')
})
