import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../../../store/slices/worktrees/worktrees-slice-test-harness'
import { makeDetectedResult } from '../../../store/slices/worktrees/listing/worktrees-detected-listing-fixtures'
import { makeLineage } from '../../../store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'

import { createWorktreeEventRuntime } from './worktree-event-runtime'

import {
  beginWorktreeLineageRefresh,
  invalidateRemoteWorktreeLineage,
  isRemoteWorktreeLineageFresh
} from '../../../store/slices/worktrees/metadata/worktree-lineage-readiness'

let store: ReturnType<typeof createTestStore>
let unsubs: (() => void)[]

vi.mock('../../../store', () => ({
  useAppStore: {
    get getState() {
      return store.getState
    },
    get setState() {
      return store.setState
    }
  }
}))
const sshStateGeneration = vi.hoisted(() => ({ value: 0 }))
vi.mock('@/store/slices/ssh/runtime-environment-ssh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironmentSshStateGeneration: () => sshStateGeneration.value
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  store = createTestStore()
  unsubs = []
  store.setState({
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    purgeWorktreeTerminalState: vi.fn(),
    removeWorkspaceSpaceWorktrees: vi.fn(),
    migrateWorktreeIdentity: vi.fn(),
    setActiveWorktree: vi.fn()
  })
  beginWorktreeLineageRefresh(store.getState, { kind: 'environment', environmentId: 'env-1' })(true)
})

afterEach(() => {
  for (const unsubscribe of unsubs) {
    unsubscribe()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function createActualActionFixture() {
  store = createTestStore()
  const worktree = makeWorktree({
    id: 'repo::/remote/child',
    repoId: 'repo',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1',
    sortOrder: 10
  })
  const lineage = makeLineage({ worktreeId: worktree.id })
  let sortOrder = 10
  let listingHold: Promise<void> = Promise.resolve()
  let lineageReply: () => Promise<unknown> = async () => ({ lineage: { [worktree.id]: lineage } })
  runtimeEnvironmentCall.mockImplementation(async ({ method }) => {
    let result: unknown
    if (method === 'worktree.lineageList') {
      result = await lineageReply()
    } else {
      await listingHold
      result = makeDetectedResult('repo', [{ ...worktree, sortOrder }])
    }
    return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
  })
  store.setState({
    settings: null,
    repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'runtime:env-1' }],
    worktreesByRepo: { repo: [worktree] },
    sortEpoch: 7,
    purgeWorktreeTerminalState: vi.fn(),
    removeWorkspaceSpaceWorktrees: vi.fn()
  })
  const runtime = createWorktreeEventRuntime(unsubs, () => false)
  return {
    lineage,
    worktree,
    queue: runtime.worktreeChangeRefreshQueue,
    setOrder: (value: number) => {
      sortOrder = value
    },
    holdListing: (promise: Promise<void>) => {
      listingHold = promise
    },
    setLineageReply: (reply: () => Promise<unknown>) => {
      lineageReply = reply
    },
    lineageReadCount: () =>
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      ).length,
    warm: () => store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
  }
}

describe('order-only refresh with actual store actions', () => {
  it('does not invalidate a healthy host from an event received after disposal', async () => {
    const h = createActualActionFixture()
    await h.warm()
    h.queue.dispose()
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(true)
    invalidateRemoteWorktreeLineage(store.getState, 'env-1')
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(false)
  })
})
