import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { showLocalBaseRefRefreshToast } from '@/store/slices/worktrees/create/local-base-ref-refresh-toast'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({
  refreshToast: vi.fn<typeof showLocalBaseRefRefreshToast>(),
  suggestionToast: vi.fn(),
  fallbackNotice: vi.fn(),
  applyCreatedWorktree: vi.fn(),
  holdCreatedSidebarWorkspace: vi.fn(),
  rpc: vi.fn(),
  setState: vi.fn(),
  state: {
    updateSettings: vi.fn<AppState['updateSettings']>(),
    getKnownWorktreeById: vi.fn(),
    fetchWorktrees: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    settings: {}
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state, setState: mocks.setState }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store/slices/worktrees/create/created-worktree-state-merge', () => ({
  applyCreatedWorktree: mocks.applyCreatedWorktree
}))
vi.mock('@/lib/sidebar-pending-layer', () => ({
  holdCreatedSidebarWorkspace: mocks.holdCreatedSidebarWorkspace
}))
vi.mock('@/store/slices/worktrees/create/local-base-ref-refresh-toast', () => ({
  showLocalBaseRefRefreshToast: mocks.refreshToast
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: mocks.fallbackNotice
}))
vi.mock('@/components/sidebar/local-base-ref-suggestion-toast', () => ({
  showLocalBaseRefUpdateSuggestionToast: mocks.suggestionToast
}))

import { acceptHostCreatedWorktree } from './worktree-creation-host-result'

afterEach(() => vi.clearAllMocks())

it('forwards refresh notice dependencies from the creation host and honors notice suppression', async () => {
  const executionHostId = 'runtime:remote-runtime'
  const target = { kind: 'environment', environmentId: 'remote-runtime' } as const
  const result = {
    worktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: executionHostId }),
    localBaseRefRefresh: {
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main',
      shallowHistory: true
    }
  } satisfies CreateWorktreeResult
  const launch = { worktreeId: result.worktree.id, created: result }
  mocks.state.getKnownWorktreeById.mockReturnValue(result.worktree)

  expect(await acceptHostCreatedWorktree(target, launch, 'repo-1', executionHostId)).toBe(result)
  expect(mocks.refreshToast).toHaveBeenCalledExactlyOnceWith(
    result.localBaseRefRefresh,
    result.worktree,
    { updateSettings: mocks.state.updateSettings, executionHostId }
  )
  const [refresh, worktree, deps] = mocks.refreshToast.mock.calls[0]
  expect(refresh).toBe(result.localBaseRefRefresh)
  expect(worktree).toBe(result.worktree)
  expect(deps.updateSettings).toBe(mocks.state.updateSettings)
  expect(deps.executionHostId).toBe(executionHostId)

  await acceptHostCreatedWorktree(target, launch, 'repo-1', executionHostId, () => false)
  expect(mocks.refreshToast).toHaveBeenCalledTimes(1)
  expect(mocks.suggestionToast).toHaveBeenCalledTimes(1)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
})
