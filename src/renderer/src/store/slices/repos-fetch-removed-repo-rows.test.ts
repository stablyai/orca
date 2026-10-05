// `orca project setup-delete` removes a repo from outside the window; the window only learns
// through repos:changed -> fetchRepos. The rows of the removed repo lingered in the sidebar
// (under "Unknown") until a force reload because fetchRepos replaced `repos` but not the
// worktree maps the sidebar builds rows from.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const keptRepo: Repo = {
  id: 'repo-kept',
  path: '/kept',
  displayName: 'Kept',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'local'
}
const removedRepo: Repo = { ...keptRepo, id: 'repo-removed', path: '/removed', addedAt: 2 }
const runtimeRepo: Repo = {
  ...keptRepo,
  id: 'repo-runtime',
  path: '/srv/runtime',
  addedAt: 3,
  executionHostId: 'runtime:env-1'
}
const UNKNOWN_REPO_ID = 'repo-not-yet-in-catalog'

const reposList = vi.fn()

function worktreeOf(repo: { id: string; path: string }, hostId?: ExecutionHostId): Worktree {
  return makeWorktree({
    id: `${repo.id}::${repo.path}/wt`,
    repoId: repo.id,
    path: `${repo.path}/wt`,
    ...(hostId ? { hostId } : {})
  })
}

// Why: catalogs arrive over IPC, so every fetch hands back fresh rows.
function mockLocalCatalog(...rows: Repo[]): void {
  reposList.mockImplementation(async () => rows.map((row) => structuredClone(row)))
}

function seededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const seededRows = [
    { id: keptRepo.id, path: keptRepo.path },
    { id: removedRepo.id, path: removedRepo.path },
    { id: runtimeRepo.id, path: runtimeRepo.path, hostId: 'runtime:env-1' as const },
    { id: UNKNOWN_REPO_ID, path: '/unknown' }
  ]
  store.setState({
    repos: [keptRepo, removedRepo, runtimeRepo],
    worktreesByRepo: Object.fromEntries(
      seededRows.map((row) => [row.id, [worktreeOf(row, row.hostId)]])
    ),
    detectedWorktreesByRepo: Object.fromEntries(
      seededRows.map((row) => [row.id, makeDetectedResult(row.id, [worktreeOf(row, row.hostId)])])
    )
  })
  return store
}

beforeEach(() => {
  reposList.mockReset()
  mockLocalCatalog(keptRepo)
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      }
    },
    dispatchEvent: vi.fn()
  })
})

describe('fetchRepos drops the rows of a repo removed outside the window', () => {
  it('removes worktree and detected-worktree rows of a repo the catalog no longer has', async () => {
    const store = seededStore()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(s.repos.map((repo) => repo.id)).not.toContain(removedRepo.id)
    expect(s.worktreesByRepo).not.toHaveProperty(removedRepo.id)
    expect(s.detectedWorktreesByRepo).not.toHaveProperty(removedRepo.id)
  })

  it('keeps rows of surviving repos as the same object references', async () => {
    const store = seededStore()
    const before = store.getState()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.worktreesByRepo[keptRepo.id]).toBe(before.worktreesByRepo[keptRepo.id])
    expect(s.detectedWorktreesByRepo[keptRepo.id]).toBe(before.detectedWorktreesByRepo[keptRepo.id])
  })

  it('keeps rows keyed by a repo id the store never had, since the catalog can lag hydration', async () => {
    const store = seededStore()
    const before = store.getState()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.worktreesByRepo[UNKNOWN_REPO_ID]).toBe(before.worktreesByRepo[UNKNOWN_REPO_ID])
    expect(s.detectedWorktreesByRepo[UNKNOWN_REPO_ID]).toBe(
      before.detectedWorktreesByRepo[UNKNOWN_REPO_ID]
    )
  })

  it('keeps repos and rows owned by another host on a local fetch', async () => {
    const store = seededStore()
    const before = store.getState()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.repos.map((repo) => repo.id)).toContain(runtimeRepo.id)
    expect(s.worktreesByRepo[runtimeRepo.id]).toBe(before.worktreesByRepo[runtimeRepo.id])
    expect(s.detectedWorktreesByRepo[runtimeRepo.id]).toBe(
      before.detectedWorktreesByRepo[runtimeRepo.id]
    )
  })

  it('keeps both worktree maps by identity when no repo was removed', async () => {
    const store = seededStore()
    mockLocalCatalog(keptRepo, removedRepo)
    const before = store.getState()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(s.worktreesByRepo).toBe(before.worktreesByRepo)
    expect(s.detectedWorktreesByRepo).toBe(before.detectedWorktreesByRepo)
  })
})
