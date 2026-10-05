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

  it('kills a pre-existing PTY only once when a refetch runs mid-removal', async () => {
    const store = seededStore()
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    let ptyTabsAfterRefetch: string[] = []
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
      ptyTabsAfterRefetch = Object.keys(store.getState().ptyIdsByTabId)
    })

    await store.getState().removeProject(removedRepo.id)

    // Proves the refetch dropped the repo yet left its PTY ids to removeProject, so both of
    // removeProject's reads see them and a second kill would show up here.
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(reposDuringRemove).toEqual([keptRepo.id])
    expect(ptyTabsAfterRefetch).toContain('tab-listed')
    expect(ptyTabsAfterRefetch).toContain('tab-detected')
    expect(killCount('pty-listed')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(ptyKill).toHaveBeenCalledTimes(2)
  })

  it('kills a PTY that attached during repos.remove before a refetch dropped the repo', async () => {
    const store = seededStore()
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    reposRemove.mockImplementation(async () => {
      store.setState((s) => ({
        ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-listed': ['pty-listed', 'pty-late'] }
      }))
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
    })

    await store.getState().removeProject(removedRepo.id)

    // Proves the refetch ran after the attach and inside repos.remove, and dropped the repo.
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(reposDuringRemove).toEqual([keptRepo.id])
    expect(killCount('pty-late')).toBe(1)
    expect(killCount('pty-listed')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(ptyKill).toHaveBeenCalledTimes(3)
    const s = store.getState()
    expect(s.tabsByWorktree).not.toHaveProperty(LISTED_WORKTREE_ID)
    expect(s.tabsByWorktree).not.toHaveProperty(DETECTED_ONLY_WORKTREE_ID)
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-listed')
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-detected')
  })
})

describe('fetchRepos still purges what removeProject will not purge itself', () => {
  it('drops workspace-space entries of the removed repo worktrees during the refetch', async () => {
    const store = seededStore()
    const keptWorktreeId = 'repo-kept::/kept/wt'
    store.setState({
      workspaceSpaceMeasurements: [
        LISTED_WORKTREE_ID,
        DETECTED_ONLY_WORKTREE_ID,
        keptWorktreeId
      ].map((worktreeId) => ({ worktreeId, status: 'ok' as const, sizeBytes: 1 }))
    })
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
    })

    await store.getState().removeProject(removedRepo.id)

    expect(reposDuringRemove).toEqual([keptRepo.id])
    expect(
      store.getState().workspaceSpaceMeasurements.map((measurement) => measurement.worktreeId)
    ).toEqual([keptWorktreeId])
  })

  it('purges another repo that the mid-removal refetch drops', async () => {
    const store = seededStore()
    const otherRepo: Repo = { ...removedRepo, id: 'repo-other', path: '/other', addedAt: 3 }
    const otherWorktreeId = 'repo-other::/other/wt'
    store.setState((s) => ({
      repos: [...s.repos, otherRepo],
      worktreesByRepo: {
        ...s.worktreesByRepo,
        [otherRepo.id]: [
          makeWorktree({ id: otherWorktreeId, repoId: otherRepo.id, path: '/other/wt' })
        ]
      },
      tabsByWorktree: {
        ...s.tabsByWorktree,
        [otherWorktreeId]: [makeTab({ id: 'tab-other', worktreeId: otherWorktreeId })]
      },
      ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-other': ['pty-other'] }
    }))
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
    })

    await store.getState().removeProject(removedRepo.id)

    const s = store.getState()
    expect(s.repos.map((repo) => repo.id)).toEqual([keptRepo.id])
    expect(s.tabsByWorktree).not.toHaveProperty(otherWorktreeId)
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-other')
  })

  it('purges the repo on a later refetch after removeProject failed', async () => {
    const store = seededStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reposRemove.mockRejectedValue(new Error('remove failed'))

    await store.getState().removeProject(removedRepo.id)
    consoleError.mockRestore()

    // Proves the failed removal left the repo and its terminal state in place and killed nothing.
    expect(ptyKill).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree).toHaveProperty(LISTED_WORKTREE_ID)
    expect(store.getState().tabsByWorktree).toHaveProperty(DETECTED_ONLY_WORKTREE_ID)
    expect(store.getState().ptyIdsByTabId).toHaveProperty('tab-listed')
    expect(store.getState().ptyIdsByTabId).toHaveProperty('tab-detected')
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.tabsByWorktree).not.toHaveProperty(LISTED_WORKTREE_ID)
    expect(s.tabsByWorktree).not.toHaveProperty(DETECTED_ONLY_WORKTREE_ID)
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-listed')
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-detected')
  })

  it('purges the repo terminal state when repos.remove fails after a refetch dropped it', async () => {
    const store = seededStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    reposRemove.mockImplementation(async () => {
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
      throw new Error('remove timed out')
    })

    await store.getState().removeProject(removedRepo.id)
    consoleError.mockRestore()

    // Proves the refetch dropped the repo rows, so no later refetch would purge its worktrees.
    expect(reposDuringRemove).toEqual([keptRepo.id])
    const s = store.getState()
    expect(s.worktreesByRepo).not.toHaveProperty(removedRepo.id)
    expect(s.detectedWorktreesByRepo).not.toHaveProperty(removedRepo.id)
    expect(s.tabsByWorktree).not.toHaveProperty(LISTED_WORKTREE_ID)
    expect(s.tabsByWorktree).not.toHaveProperty(DETECTED_ONLY_WORKTREE_ID)
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-listed')
    expect(s.ptyIdsByTabId).not.toHaveProperty('tab-detected')
  })

  it('kills each local PTY once when repos.remove fails after a refetch dropped the repo', async () => {
    const store = seededStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reposList.mockImplementation(async () => [structuredClone(keptRepo)])
    let reposDuringRemove: string[] = []
    reposRemove.mockImplementation(async () => {
      store.setState((s) => ({
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          'tab-listed': ['pty-listed', 'pty-late', 'remote:pty-remote']
        }
      }))
      await store.getState().fetchRepos()
      reposDuringRemove = store.getState().repos.map((repo) => repo.id)
      throw new Error('remove timed out')
    })

    await store.getState().removeProject(removedRepo.id)
    consoleError.mockRestore()

    // Proves the refetch ran after the attach and dropped the repo before the remove failed.
    expect(reposDuringRemove).toEqual([keptRepo.id])
    expect(killCount('pty-listed')).toBe(1)
    expect(killCount('pty-detected')).toBe(1)
    expect(killCount('pty-late')).toBe(1)
    expect(killCount('remote:pty-remote')).toBe(0)
    expect(ptyKill).toHaveBeenCalledTimes(3)
  })
})
