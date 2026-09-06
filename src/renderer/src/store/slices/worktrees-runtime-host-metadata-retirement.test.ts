// Why this file exists: a paired client's WorktreeMeta for a runtime host is exempt from
// gcStaleWorktreeMeta (it skips any row that is not local on both the repo and the meta's hostId),
// and `forgetPersistedWorktreeMetaForRemovals` used to bail for every non-SSH host. So the client
// kept a row per remote worktree it had ever seen and dropped none (#17776).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import {
  createTestStore,
  forgetRemovedForExecutionHostMock,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const REPO_ID = 'repo-runtime'
const HOST_ID = 'runtime:env-1'

const worktree = (path: string) =>
  makeWorktree({ id: `${REPO_ID}::${path}`, repoId: REPO_ID, path, hostId: HOST_ID })

const live = worktree('/home/orca/live')
const deletedOnHost = worktree('/home/orca/deleted')

function seedClientWithBothRows(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
    repos: [
      {
        id: REPO_ID,
        path: '/home/orca/repo',
        displayName: 'Runtime Repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: HOST_ID
      }
    ],
    worktreesByRepo: { [REPO_ID]: [live, deletedOnHost] }
  } as Partial<AppState>)
  return store
}

beforeEach(resetWorktreeSliceModuleMemory)

describe('runtime-host persisted metadata retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('retires metadata for rows an authoritative runtime-host scan proved gone', async () => {
    const store = seedClientWithBothRows()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-detected',
      ok: true,
      result: makeDetectedResult(REPO_ID, [live]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees(REPO_ID, { executionHostId: HOST_ID })

    expect(forgetRemovedForExecutionHostMock).toHaveBeenCalledExactlyOnceWith({
      repoId: REPO_ID,
      executionHostId: HOST_ID,
      worktreeIds: [deletedOnHost.id]
    })
  })

  // A non-authoritative reply is a failed listing, not a report that a checkout is gone.
  it('retires nothing when the runtime host could not scan', async () => {
    const store = seedClientWithBothRows()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-detected',
      ok: true,
      result: makeDetectedResult(REPO_ID, [live], {
        authoritative: false,
        source: 'metadata-fallback'
      }),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees(REPO_ID, { executionHostId: HOST_ID })

    expect(forgetRemovedForExecutionHostMock).not.toHaveBeenCalled()
  })

  // `session-fallback` claims authoritative but is the truncated, visibility-filtered `worktree.list`
  // reply from a host too old for `worktree.detectedList`. Its omissions prove nothing.
  it('retires nothing from a legacy session-fallback listing', async () => {
    const store = seedClientWithBothRows()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-detected',
      ok: true,
      result: makeDetectedResult(REPO_ID, [live], { source: 'session-fallback' }),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees(REPO_ID, { executionHostId: HOST_ID })

    expect(forgetRemovedForExecutionHostMock).not.toHaveBeenCalled()
  })
})
