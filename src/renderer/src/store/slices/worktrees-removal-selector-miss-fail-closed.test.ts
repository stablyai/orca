import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why (#16243): a selector_not_found from the runtime used to fall through to a
// local-only forgetLocal whenever the catalog still listed the workspace, which
// read as success while nothing was deleted remotely — the row returned on the
// next refresh. A live route on the confirmed host must fail visibly instead.
describe('removeWorktree runtime selector miss', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('fails closed instead of forgetting locally when the catalog still resolves the route', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-rm',
      ok: false,
      error: { code: 'selector_not_found', message: 'selector_not_found' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null }, false)

    expect(result).toMatchObject({ ok: false })
    expect(String((result as { error?: string }).error)).toContain('selector_not_found')
    expect(mockApi.worktrees.forgetLocal).not.toHaveBeenCalled()
    // The live row must not be dropped from the shared renderer state either.
    expect(store.getState().worktreesByRepo.repo1).toHaveLength(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })
})
