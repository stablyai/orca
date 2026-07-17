import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  __resetProjectQuickCommandsFetchesForTests,
  collectProjectQuickCommandsForRepos,
  createProjectQuickCommandsSlice,
  omitProjectQuickCommandsForRepos,
  selectProjectQuickCommandsForRepo
} from './project-quick-commands'

const checkRuntimeHooksMock = vi.fn()
vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: (...args: unknown[]) => checkRuntimeHooksMock(...args)
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createProjectQuickCommandsSlice(...a),
        repos: [{ id: 'repo-1', displayName: 'Repo One' }],
        settings: null
      }) as AppState
  )
}

function okHooksResult(quickCommands: unknown) {
  return {
    status: 'ok',
    hasHooks: true,
    hooks: { scripts: {}, quickCommands },
    mayNeedUpdate: false
  }
}

describe('createProjectQuickCommandsSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetProjectQuickCommandsFetchesForTests()
  })

  it('loads orca.yaml quick commands into the repo bucket as repo-scoped commands', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([{ action: 'terminal-command', label: 'Dev server', command: 'pnpm dev' }])
    )

    await store.getState().loadProjectQuickCommands('repo-1')

    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(1)
    expect(store.getState().projectQuickCommandsByRepo).toEqual({
      'repo-1': [
        {
          id: 'orca-yaml:dev-server',
          label: 'Dev server',
          action: 'terminal-command',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        }
      ]
    })
  })

  it('caches an empty bucket when the repo has no quick commands', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValue({
      status: 'ok',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })

    await store.getState().loadProjectQuickCommands('repo-1')

    expect(store.getState().projectQuickCommandsByRepo).toEqual({ 'repo-1': [] })
  })

  it('short-circuits repeat loads and re-reads only on refresh', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValue(okHooksResult([]))

    await store.getState().loadProjectQuickCommands('repo-1')
    await store.getState().loadProjectQuickCommands('repo-1')
    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(1)

    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })
    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(2)
  })

  it('preserves cache references when a refresh returns unchanged commands', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([{ action: 'terminal-command', label: 'Build', command: 'make' }])
    )
    await store.getState().loadProjectQuickCommands('repo-1')
    const previousMap = store.getState().projectQuickCommandsByRepo
    const previousCommands = previousMap['repo-1']
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })

    expect(store.getState().projectQuickCommandsByRepo).toBe(previousMap)
    expect(store.getState().projectQuickCommandsByRepo['repo-1']).toBe(previousCommands)
    expect(subscriber).not.toHaveBeenCalled()

    checkRuntimeHooksMock.mockResolvedValue(
      okHooksResult([{ action: 'terminal-command', label: 'Build', command: 'make test' }])
    )
    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })

    expect(store.getState().projectQuickCommandsByRepo).not.toBe(previousMap)
    expect(store.getState().projectQuickCommandsByRepo['repo-1']).not.toBe(previousCommands)
    expect(store.getState().projectQuickCommandsByRepo['repo-1']?.[0]).toMatchObject({
      command: 'make test'
    })
    expect(subscriber).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('keeps the previous snapshot when a refresh fails', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValueOnce(
      okHooksResult([{ action: 'terminal-command', label: 'Build', command: 'make' }])
    )
    await store.getState().loadProjectQuickCommands('repo-1')
    const loaded = store.getState().projectQuickCommandsByRepo['repo-1']
    expect(loaded).toHaveLength(1)

    checkRuntimeHooksMock.mockResolvedValueOnce({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })
    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })
    expect(store.getState().projectQuickCommandsByRepo['repo-1']).toBe(loaded)

    checkRuntimeHooksMock.mockRejectedValueOnce(new Error('boom'))
    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })
    expect(store.getState().projectQuickCommandsByRepo['repo-1']).toBe(loaded)
  })

  it('skips loading and drops the cache when the repo id is duplicated across hosts', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValue(okHooksResult([]))
    await store.getState().loadProjectQuickCommands('repo-1')
    expect(store.getState().projectQuickCommandsByRepo).toEqual({ 'repo-1': [] })

    store.setState({
      repos: [
        { id: 'repo-1', displayName: 'Repo One' },
        { id: 'repo-1', displayName: 'Repo One (ssh)' }
      ]
    } as unknown as Partial<AppState>)
    expect(selectProjectQuickCommandsForRepo(store.getState(), 'repo-1')).toBeUndefined()
    expect(collectProjectQuickCommandsForRepos(store.getState())).toEqual([])
    await store.getState().loadProjectQuickCommands('repo-1', { refresh: true })

    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(1)
    expect(store.getState().projectQuickCommandsByRepo).toEqual({})
  })

  it('reloads a cached bare repo id when its owner host changes', async () => {
    const store = createTestStore()
    checkRuntimeHooksMock.mockResolvedValueOnce(
      okHooksResult([{ action: 'terminal-command', label: 'Local', command: 'echo local' }])
    )
    await store.getState().loadProjectQuickCommands('repo-1')

    store.setState({
      repos: [{ id: 'repo-1', displayName: 'Repo One (SSH)', connectionId: 'ssh-1' }]
    } as unknown as Partial<AppState>)
    expect(selectProjectQuickCommandsForRepo(store.getState(), 'repo-1')).toBeUndefined()
    checkRuntimeHooksMock.mockResolvedValueOnce(
      okHooksResult([{ action: 'terminal-command', label: 'SSH', command: 'echo ssh' }])
    )

    await store.getState().loadProjectQuickCommands('repo-1')

    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(2)
    expect(selectProjectQuickCommandsForRepo(store.getState(), 'repo-1')?.[0]).toMatchObject({
      label: 'SSH',
      command: 'echo ssh'
    })
  })

  it('does not resurrect a removed repo bucket after an in-flight read completes', async () => {
    const store = createTestStore()
    let resolveRead!: (value: ReturnType<typeof okHooksResult>) => void
    checkRuntimeHooksMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )

    const load = store.getState().loadProjectQuickCommands('repo-1')
    await vi.waitFor(() => expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(1))
    store.setState({ repos: [] })
    resolveRead(
      okHooksResult([{ action: 'terminal-command', label: 'Stale', command: 'echo stale' }])
    )
    await load

    expect(store.getState().projectQuickCommandsByRepo).toEqual({})
  })

  it('does not coalesce a replacement host with the previous owner request', async () => {
    const store = createTestStore()
    const pendingReads: ((value: ReturnType<typeof okHooksResult>) => void)[] = []
    checkRuntimeHooksMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingReads.push(resolve)
        })
    )

    const oldOwnerLoad = store.getState().loadProjectQuickCommands('repo-1')
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1))
    store.setState({
      repos: [{ id: 'repo-1', displayName: 'Repo One (SSH)', connectionId: 'ssh-1' }]
    } as unknown as Partial<AppState>)
    const newOwnerLoad = store.getState().loadProjectQuickCommands('repo-1', { refresh: true })
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2))

    pendingReads[1](
      okHooksResult([{ action: 'terminal-command', label: 'New', command: 'echo new' }])
    )
    await newOwnerLoad
    expect(store.getState().projectQuickCommandsByRepo['repo-1']?.[0]).toMatchObject({
      label: 'New',
      command: 'echo new'
    })

    pendingReads[0](
      okHooksResult([{ action: 'terminal-command', label: 'Old', command: 'echo old' }])
    )
    await oldOwnerLoad
    expect(store.getState().projectQuickCommandsByRepo['repo-1']?.[0]).toMatchObject({
      label: 'New',
      command: 'echo new'
    })
  })
})

describe('omitProjectQuickCommandsForRepos', () => {
  it('drops buckets for removed repos and reports no change otherwise', () => {
    const state = {
      projectQuickCommandsByRepo: { 'repo-1': [], 'repo-2': [] },
      projectQuickCommandOwnerByRepo: { 'repo-1': 'local', 'repo-2': 'ssh:ssh-1' }
    } as unknown as Pick<AppState, 'projectQuickCommandsByRepo' | 'projectQuickCommandOwnerByRepo'>

    expect(omitProjectQuickCommandsForRepos(state, ['repo-2'])).toEqual({
      projectQuickCommandsByRepo: { 'repo-1': [] },
      projectQuickCommandOwnerByRepo: { 'repo-1': 'local' }
    })
    expect(omitProjectQuickCommandsForRepos(state, ['repo-3'])).toEqual({})
    expect(omitProjectQuickCommandsForRepos(state, [])).toEqual({})
  })
})
