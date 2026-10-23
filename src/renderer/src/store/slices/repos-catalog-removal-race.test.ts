import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getWorktreeVisitKey } from '../../lib/worktree-visit-recency'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

const repo: Repo = {
  id: 'removed',
  path: '/removed',
  displayName: 'Removed',
  badgeColor: '#000',
  addedAt: 1
}
const id = 'removed::/removed'
const remove = vi.fn()
const kill = vi.fn()
const list = vi.fn()

beforeEach(() => {
  remove.mockReset()
  kill.mockReset()
  list.mockReset().mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      repos: { list, removeForHost: remove },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      pty: { kill }
    },
    dispatchEvent: vi.fn()
  })
})

function seed(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    repos: [repo],
    worktreesByRepo: {
      removed: [makeWorktree({ id, repoId: repo.id, path: '/removed', hostId: 'local' })]
    },
    tabsByWorktree: { [id]: [makeTab({ id: 'tab', worktreeId: id, ptyId: 'pty-before' })] },
    ptyIdsByTabId: { tab: ['pty-before'] },
    lastVisitedAtByWorktreeId: { [getWorktreeVisitKey(id, 'local')]: 1 }
  })
  return store
}

describe('repo catalog observation during explicit removal', () => {
  it('keeps a late PTY mapping through the refetch so explicit removal kills it once', async () => {
    const store = seed()
    remove.mockImplementation(async () => {
      store.setState({ ptyIdsByTabId: { tab: ['pty-before', 'pty-late'] } })
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    })

    await store.getState().removeProject(repo.id, { hostId: 'local' })

    expect(kill.mock.calls.flat()).toEqual(['pty-before', 'pty-late'])
    expect(store.getState().tabsByWorktree[id]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId.tab).toBeUndefined()
    expect(store.getState().worktreesByRepo.removed).toBeUndefined()
  })

  it('includes a newly attached worktree whose row the refetch already dropped', async () => {
    const store = seed()
    const lateId = 'removed::/removed/late'
    remove.mockImplementation(async () => {
      store.setState((state) => ({
        worktreesByRepo: {
          removed: [
            ...(state.worktreesByRepo.removed ?? []),
            makeWorktree({ id: lateId, repoId: repo.id, hostId: 'local' })
          ]
        },
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [lateId]: [makeTab({ id: 'late-tab', worktreeId: lateId, ptyId: 'late-worktree-pty' })]
        },
        ptyIdsByTabId: { ...state.ptyIdsByTabId, 'late-tab': ['late-worktree-pty'] }
      }))
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    })

    await store.getState().removeProject(repo.id, { hostId: 'local' })

    expect(kill.mock.calls.flat()).toEqual(['pty-before', 'late-worktree-pty'])
    expect(store.getState().tabsByWorktree[lateId]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId['late-tab']).toBeUndefined()
  })

  it('clears observed-removed state after a failed explicit removal and releases the guard', async () => {
    const store = seed()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    remove.mockImplementation(async () => {
      store.setState({ ptyIdsByTabId: { tab: ['pty-before', 'pty-late'] } })
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
      throw new Error('reply lost')
    })
    try {
      await store.getState().removeProject(repo.id, { hostId: 'local' })
      expect(kill.mock.calls.flat()).toEqual(['pty-before', 'pty-late'])
      expect(store.getState().tabsByWorktree[id]).toBeUndefined()
      expect(store.getState().ptyIdsByTabId.tab).toBeUndefined()
      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
      expect(kill).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  it('a failed removal without accepted absence keeps the live tab and PTYs', async () => {
    const store = seed()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    remove.mockRejectedValue(new Error('denied'))
    try {
      await store.getState().removeProject(repo.id, { hostId: 'local' })
      expect(store.getState().tabsByWorktree[id]).toHaveLength(1)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
