import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

const mocks = vi.hoisted(() => {
  const repos: Repo[] = []
  const worktreesByRepo: Record<string, { id: string; hostId: string; path: string }[]> = {}
  return {
    ensure: vi.fn(),
    add: vi.fn(),
    fetch: vi.fn(),
    mark: vi.fn(),
    error: vi.fn(),
    repos,
    worktreesByRepo
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: () => () => {},
    getState: () => ({
      repos: mocks.repos,
      addRepoPath: mocks.add,
      fetchWorktrees: mocks.fetch,
      worktreesByRepo: mocks.worktreesByRepo
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
vi.mock('./onboarding-project-checklist', () => ({ markOnboardingProjectAdded: mocks.mark }))
vi.mock('@/store/workspace-record-selectors', () => ({
  selectWorktreesByRepo: (state: { worktreesByRepo: unknown }) => state.worktreesByRepo
}))
import { startQuickChat } from './start-quick-chat'

const repo: Repo = {
  id: 'chats',
  path: '/data/chats',
  displayName: 'My chats',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'folder'
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.repos = []
  mocks.worktreesByRepo = {}
  vi.stubGlobal('window', { api: { repos: { ensureQuickChatFolder: mocks.ensure } } })
  mocks.ensure.mockImplementation(async () => ({ path: repo.path, repoId: mocks.repos[0]?.id }))
  mocks.add.mockImplementation(async () => {
    if (!mocks.repos.length) {
      mocks.repos.push(repo)
    }
    return repo
  })
  mocks.fetch.mockImplementation(async () => {
    mocks.worktreesByRepo[repo.id] = [
      { id: 'folder-chats', hostId: LOCAL_EXECUTION_HOST_ID, path: repo.path }
    ]
    return true
  })
  mocks.mark.mockResolvedValue(null)
})

describe('startQuickChat', () => {
  it('adds once, then reuses the project without touching its name or settings', async () => {
    expect(await startQuickChat()).toEqual({ repoId: 'chats', worktreeId: 'folder-chats' })
    expect(await startQuickChat()).toEqual({ repoId: 'chats', worktreeId: 'folder-chats' })
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith('/data/chats', 'folder', {
      runtimeEnvironmentId: null,
      displayName: 'Chats'
    })
    expect(mocks.repos).toEqual([repo])
    expect(repo.displayName).toBe('My chats')
    expect(mocks.ensure).toHaveBeenCalledTimes(2)
    expect(mocks.fetch).toHaveBeenCalledWith(repo.id, { executionHostId: LOCAL_EXECUTION_HOST_ID })
  })
  it('lets two concurrent requests continue to two chats with one registration', async () => {
    const openChat = vi.fn()
    await Promise.all([startQuickChat().then(openChat), startQuickChat().then(openChat)])
    expect(mocks.repos).toHaveLength(1)
    expect(openChat.mock.calls).toEqual([
      [{ repoId: 'chats', worktreeId: 'folder-chats' }],
      [{ repoId: 'chats', worktreeId: 'folder-chats' }]
    ])
  })
  it('waits for the host-qualified worktree fetch, without waiting for onboarding', async () => {
    let release: (value: boolean) => void = () => {}
    mocks.fetch.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    mocks.mark.mockImplementation(() => new Promise(() => {}))
    const launch = vi.fn()
    const started = startQuickChat().then(launch)
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(launch).not.toHaveBeenCalled()
    mocks.worktreesByRepo[repo.id] = [
      { id: 'folder-chats', hostId: LOCAL_EXECUTION_HOST_ID, path: repo.path }
    ]
    release(true)
    await started
    expect(launch).toHaveBeenCalledWith({ repoId: 'chats', worktreeId: 'folder-chats' })
  })
  it('shows one toast and never adds if folder validation fails', async () => {
    mocks.ensure.mockRejectedValue(new Error('EEXIST'))
    expect(await startQuickChat()).toBeNull()
    expect(mocks.error).toHaveBeenCalledTimes(1)
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('leaves add failures to the existing add-folder toast', async () => {
    mocks.add.mockResolvedValue(null)
    expect(await startQuickChat()).toBeNull()
    expect(mocks.error).not.toHaveBeenCalled()
  })
  it('shows one toast and does not continue after a failed fetch', async () => {
    mocks.fetch.mockResolvedValue(false)
    expect(await startQuickChat()).toBeNull()
    expect(mocks.error).toHaveBeenCalledTimes(1)
  })
})

it('selects the registered checkout path instead of the first local row for an existing linked Git project', async () => {
  mocks.repos = [{ ...repo, kind: 'git' }]
  mocks.fetch.mockImplementation(async () => {
    mocks.worktreesByRepo[repo.id] = [
      { id: 'main', path: '/elsewhere/main', hostId: 'local' },
      { id: 'linked-chats', path: repo.path, hostId: 'local' }
    ]
    return true
  })
  await expect(startQuickChat()).resolves.toEqual({ repoId: repo.id, worktreeId: 'linked-chats' })
  expect(mocks.add).not.toHaveBeenCalled()
})
