import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  __resetProjectQuickCommandsFetchesForTests,
  createProjectQuickCommandsSlice,
  omitProjectQuickCommandsForRepos
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
})

describe('omitProjectQuickCommandsForRepos', () => {
  it('drops buckets for removed repos and reports no change otherwise', () => {
    const state = {
      projectQuickCommandsByRepo: { 'repo-1': [], 'repo-2': [] }
    } as unknown as Pick<AppState, 'projectQuickCommandsByRepo'>

    expect(omitProjectQuickCommandsForRepos(state, ['repo-2'])).toEqual({
      projectQuickCommandsByRepo: { 'repo-1': [] }
    })
    expect(omitProjectQuickCommandsForRepos(state, ['repo-3'])).toEqual({})
    expect(omitProjectQuickCommandsForRepos(state, [])).toEqual({})
  })
})
