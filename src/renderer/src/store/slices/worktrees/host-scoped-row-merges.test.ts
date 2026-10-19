import { describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../../../../shared/worktree/create-types'
import { applyCreatedWorktree } from './create/created-worktree-state-merge'
import { applyWorktreeLineageUpdate } from './metadata/worktree-lineage-refresh'
import { TEST_REPO, createTestStore, makeWorktree, seedStore } from '../store-test-helpers'
import { createStoreCascadesMockApi } from '../store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

createStoreCascadesMockApi()

const REPO_ID = TEST_REPO.id
const WORKTREE_ID = `${REPO_ID}::/srv/shared`

// The same project on this app and on paired server `hub`, with a same-id worktree on each.
function seedTwins(store: ReturnType<typeof createTestStore>) {
  const local = makeWorktree({ id: WORKTREE_ID, repoId: REPO_ID, path: '/srv/shared' })
  const remote = {
    ...local,
    hostId: 'runtime:hub' as const,
    runtimeOwnerEnvironmentId: 'hub',
    displayName: 'server copy'
  }
  seedStore(store, {
    repos: [
      { ...TEST_REPO, executionHostId: 'local' },
      { ...TEST_REPO, executionHostId: 'runtime:hub' }
    ],
    worktreesByRepo: { [REPO_ID]: [local, remote] }
  })
  return { local, remote }
}

describe('row writers touch only the copy on their own host', () => {
  it('a local create leaves the server twin, and its server stamp, alone', () => {
    const store = createTestStore()
    const { remote } = seedTwins(store)
    applyCreatedWorktree(
      store.setState,
      REPO_ID,
      {
        worktree: makeWorktree({ id: WORKTREE_ID, repoId: REPO_ID, displayName: 'fresh local' })
      } satisfies CreateWorktreeResult,
      'local'
    )
    const rows = store.getState().worktreesByRepo[REPO_ID]!
    expect(rows.find((row) => row.runtimeOwnerEnvironmentId === 'hub')).toEqual(remote)
    const localRow = rows.find((row) => !row.runtimeOwnerEnvironmentId)
    expect(localRow?.displayName).toBe('fresh local')
    expect(rows).toHaveLength(2)
  })

  it('a server create leaves the local twin alone', () => {
    const store = createTestStore()
    const { local } = seedTwins(store)
    applyCreatedWorktree(
      store.setState,
      REPO_ID,
      {
        worktree: makeWorktree({ id: WORKTREE_ID, repoId: REPO_ID, displayName: 'fresh remote' })
      } satisfies CreateWorktreeResult,
      'runtime:hub'
    )
    const rows = store.getState().worktreesByRepo[REPO_ID]!
    expect(rows.find((row) => !row.runtimeOwnerEnvironmentId)).toEqual(local)
    expect(rows.find((row) => row.runtimeOwnerEnvironmentId === 'hub')?.displayName).toBe(
      'fresh remote'
    )
  })

  it("a server's lineage reply updates its own copy, never the focused local twin", () => {
    const store = createTestStore()
    const { local } = seedTwins(store)
    applyWorktreeLineageUpdate(store.setState, WORKTREE_ID, {
      target: { kind: 'environment', environmentId: 'hub' },
      lineage: null,
      updatedRemoteWorktree: makeWorktree({
        id: WORKTREE_ID,
        repoId: REPO_ID,
        displayName: 'server after lineage'
      })
    })
    const rows = store.getState().worktreesByRepo[REPO_ID]!
    expect(rows.find((row) => !row.runtimeOwnerEnvironmentId)).toEqual(local)
    expect(rows.find((row) => row.runtimeOwnerEnvironmentId === 'hub')).toMatchObject({
      displayName: 'server after lineage',
      hostId: 'runtime:hub'
    })
  })

  it("never appends a server's copy when only the local twin is listed", () => {
    const store = createTestStore()
    const { local } = seedTwins(store)
    store.setState({ worktreesByRepo: { [REPO_ID]: [local] } })
    applyWorktreeLineageUpdate(store.setState, WORKTREE_ID, {
      target: { kind: 'environment', environmentId: 'hub' },
      lineage: null,
      updatedRemoteWorktree: makeWorktree({
        id: WORKTREE_ID,
        repoId: REPO_ID,
        displayName: 'server after lineage'
      })
    })
    expect(store.getState().worktreesByRepo[REPO_ID]).toEqual([local])
  })
})
