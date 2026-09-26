// Main sends repos:changed before `repos:remove` returns, so the window's fetchRepos can finish
// while removeProject is still awaiting. If that refetch prunes the removed repo's worktree rows,
// removeProject must still find its worktrees to kill their PTYs and drop their tabs.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const removedRepo: Repo = {
  id: 'repo-removed',
  path: '/removed',
  displayName: 'Removed',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'local'
}
const keptRepo: Repo = { ...removedRepo, id: 'repo-kept', path: '/kept', addedAt: 2 }

const LISTED_WORKTREE_ID = 'repo-removed::/removed/wt-listed'
const DETECTED_ONLY_WORKTREE_ID = 'repo-removed::/removed/wt-detected'

const reposList = vi.fn()
const reposRemove = vi.fn()
const ptyKill = vi.fn()

beforeEach(() => {
  reposList.mockReset()
  reposRemove.mockReset()
  ptyKill.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList, remove: reposRemove },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: vi.fn() }
    },
    dispatchEvent: vi.fn()
  })
})

function seededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const listed = makeWorktree({
    id: LISTED_WORKTREE_ID,
    repoId: removedRepo.id,
    path: '/removed/wt-listed'
  })
  const detectedOnly = makeWorktree({
    id: DETECTED_ONLY_WORKTREE_ID,
    repoId: removedRepo.id,
    path: '/removed/wt-detected'
  })
  store.setState({
    repos: [removedRepo, keptRepo],
    worktreesByRepo: { [removedRepo.id]: [listed] },
    detectedWorktreesByRepo: {
      [removedRepo.id]: makeDetectedResult(removedRepo.id, [listed, detectedOnly])
    },
    tabsByWorktree: {
      [LISTED_WORKTREE_ID]: [makeTab({ id: 'tab-listed', worktreeId: LISTED_WORKTREE_ID })],
      [DETECTED_ONLY_WORKTREE_ID]: [
        makeTab({ id: 'tab-detected', worktreeId: DETECTED_ONLY_WORKTREE_ID })
      ]
    },
    ptyIdsByTabId: { 'tab-listed': ['pty-listed'], 'tab-detected': ['pty-detected'] }
  })
  return store
}

describe('removeProject when repos:changed refetches during repos.remove', () => {
  it('still kills the removed repo PTYs and drops its tabs', async () => {
    const store = seededStore()
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
    })

    await store.getState().removeProject(removedRepo.id)

    expect(reposRemove).toHaveBeenCalledWith({ repoId: removedRepo.id })
    // Proves the refetch really ran inside repos.remove and already dropped the repo.
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(reposDuringRemove).toEqual([keptRepo.id])
    expect(ptyKill).toHaveBeenCalledWith('pty-listed')
    expect(ptyKill).toHaveBeenCalledWith('pty-detected')
    const s = store.getState()
    expect(s.tabsByWorktree).not.toHaveProperty(LISTED_WORKTREE_ID)
    expect(s.tabsByWorktree).not.toHaveProperty(DETECTED_ONLY_WORKTREE_ID)
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-listed')
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-detected')
  })
})

function killCount(ptyId: string): number {
  return ptyKill.mock.calls.filter(([killed]) => killed === ptyId).length
}

describe('removeProject kills each PTY of the removed repo exactly once', () => {
  it('kills a PTY that attached to a removed repo tab during repos.remove', async () => {
    const store = seededStore()
    store.setState({ ptyIdsByTabId: { 'tab-detected': ['pty-detected'] } })
    reposRemove.mockImplementation(async () => {
      store.setState((s) => ({ ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-listed': ['pty-late'] } }))
    })

    await store.getState().removeProject(removedRepo.id)

    expect(reposRemove).toHaveBeenCalledTimes(1)
    expect(killCount('pty-late')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(store.getState().ptyIdsByTabId).not.toHaveProperty('tab-listed')
  })

  it('kills a PTY that existed before repos.remove only once', async () => {
    const store = seededStore()
    reposRemove.mockResolvedValue(undefined)

    await store.getState().removeProject(removedRepo.id)

    expect(killCount('pty-listed')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(ptyKill).toHaveBeenCalledTimes(2)
  })

  it('kills a pre-existing PTY only once when the mid-removal refetch purged it', async () => {
    const store = seededStore()
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let ptyTabsAfterRefetch: string[] = []
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
      ptyTabsAfterRefetch = Object.keys(store.getState().ptyIdsByTabId)
    })

    await store.getState().removeProject(removedRepo.id)

    // Proves the refetch already purged the PTY ids removeProject has to kill.
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(ptyTabsAfterRefetch).not.toContain('tab-listed')
    expect(ptyTabsAfterRefetch).not.toContain('tab-detected')
    expect(killCount('pty-listed')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(ptyKill).toHaveBeenCalledTimes(2)
  })
})
