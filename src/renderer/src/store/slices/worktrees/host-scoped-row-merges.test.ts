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

  it("a server's lineage reply updates its own copy, never the focused local twin", () => {
    const store = createTestStore()
    const { local } = seedTwins(store)
    applyWorktreeLineageUpdate(store.setState, WORKTREE_ID, {
      target: { kind: 'environment', environmentId: 'hub' },
      hostId: 'runtime:hub',
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

  it("a local parent change leaves the server twin's parent and its parent's children alone (review-5 #11)", () => {
    const store = createTestStore()
    const { local, remote } = seedTwins(store)
    const PARENT_ID = `${REPO_ID}::/srv/parent`
    const parent = (row: typeof local) => ({
      ...row,
      id: PARENT_ID,
      path: '/srv/parent',
      childWorktreeIds: [WORKTREE_ID]
    })
    const localChild = { ...local, parentWorktreeId: PARENT_ID }
    const remoteChild = { ...remote, parentWorktreeId: PARENT_ID }
    const remoteParent = parent(remote)
    store.setState({
      worktreesByRepo: { [REPO_ID]: [localChild, remoteChild, parent(local), remoteParent] }
    })
    applyWorktreeLineageUpdate(store.setState, WORKTREE_ID, {
      target: { kind: 'local' },
      hostId: 'local',
      lineage: null
    })
    const rows = store.getState().worktreesByRepo[REPO_ID]!
    const onHub = (id: string) =>
      rows.find((row) => row.id === id && row.runtimeOwnerEnvironmentId === 'hub')
    const onLocal = (id: string) =>
      rows.find((row) => row.id === id && !row.runtimeOwnerEnvironmentId)
    expect(onHub(WORKTREE_ID)).toEqual(remoteChild)
    expect(onHub(PARENT_ID)).toEqual(remoteParent)
    expect(onLocal(WORKTREE_ID)).toMatchObject({ parentWorktreeId: null })
    expect(onLocal(PARENT_ID)).toMatchObject({ childWorktreeIds: [] })
  })

  it("never appends a server's copy when only the local twin is listed", () => {
    const store = createTestStore()
    const { local } = seedTwins(store)
    store.setState({ worktreesByRepo: { [REPO_ID]: [local] } })
    applyWorktreeLineageUpdate(store.setState, WORKTREE_ID, {
      target: { kind: 'environment', environmentId: 'hub' },
      hostId: 'runtime:hub',
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
