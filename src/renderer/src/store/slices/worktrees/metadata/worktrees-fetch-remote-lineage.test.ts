import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { RuntimeEnvironmentCallRequest } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { makeDetectedResult } from '../listing/worktrees-detected-listing-fixtures'
import { makeLineage, makeWorkspaceLineage } from './workspace-lineage.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { TEST_REPO } from '../../../repos/repo.test-fixture'

// The client stamps a server's repo row on arrival; focus alone never names the owner.
function createRemoteRepoStore() {
  const store = createTestStore()
  store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:env-1' }] })
  return store
}
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('keeps a parent reassignment written while the host lineage request was in flight', async () => {
    const store = createRemoteRepoStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const childKey = worktreeWorkspaceKey(worktree.id)
    const before = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/old-parent'
    })
    const beforeWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: childKey,
      parentWorkspaceKey: worktreeWorkspaceKey('repo1::/remote/old-parent')
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [before.worktreeId]: before },
      workspaceLineageByChildKey: { [childKey]: beforeWorkspace }
    } as Partial<AppState>)

    let releaseLineage: (() => void) | undefined
    const lineageReplied = new Promise<void>((resolve) => {
      releaseLineage = resolve
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        await lineageReplied
        return {
          id: 'rpc-1',
          ok: true,
          result: {
            lineage: { [before.worktreeId]: before },
            workspaceLineage: { [childKey]: beforeWorkspace }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-2',
        ok: true,
        result: makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
    const reassigned = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/new-parent'
    })
    const reassignedWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: childKey,
      parentWorkspaceKey: worktreeWorkspaceKey('repo1::/remote/new-parent')
    })
    store.setState({
      worktreeLineageById: { [reassigned.worktreeId]: reassigned },
      workspaceLineageByChildKey: { [childKey]: reassignedWorkspace }
    } as Partial<AppState>)

    releaseLineage?.()
    await pending

    expect(store.getState().worktreeLineageById).toEqual({ [reassigned.worktreeId]: reassigned })
    expect(store.getState().workspaceLineageByChildKey).toEqual({ [childKey]: reassignedWorkspace })
  })

  it('keeps a lineage row deleted while the host lineage request was in flight', async () => {
    const store = createRemoteRepoStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const childKey = worktreeWorkspaceKey(worktree.id)
    const before = makeLineage({ worktreeId: worktree.id })
    const beforeWorkspace = makeWorkspaceLineage({ childWorkspaceKey: childKey })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [before.worktreeId]: before },
      workspaceLineageByChildKey: { [childKey]: beforeWorkspace }
    } as Partial<AppState>)

    let releaseLineage: (() => void) | undefined
    const lineageReplied = new Promise<void>((resolve) => {
      releaseLineage = resolve
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        await lineageReplied
        return {
          id: 'rpc-1',
          ok: true,
          result: {
            lineage: { [before.worktreeId]: before },
            workspaceLineage: { [childKey]: beforeWorkspace }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-2',
        ok: true,
        result: makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
    store.setState({
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    } as Partial<AppState>)

    releaseLineage?.()
    await pending

    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().workspaceLineageByChildKey).toEqual({})
  })
})
