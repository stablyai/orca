// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { GitSubmoduleRepo } from '../../../../../../shared/git-submodule-repo-types'

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

import { submoduleReposWorktreePath, useSourceControlSubmoduleRepos } from './use-submodule-repos'

const REPO: GitSubmoduleRepo = { path: 'libs/sub', branch: 'main', upstream: null }
const gitApi = {
  submoduleRepos: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn()
}

beforeEach(() => {
  gitApi.submoduleRepos.mockReset().mockResolvedValue([REPO])
  for (const name of ['fetch', 'pull', 'push'] as const) {
    gitApi[name].mockReset().mockResolvedValue(undefined)
  }
  toastErrorMock.mockReset()
  Object.defineProperty(window, 'api', { configurable: true, value: { git: gitApi } })
})

afterEach(cleanup)

describe('useSourceControlSubmoduleRepos', () => {
  it('reads nothing while the worktree is hidden', () => {
    const { result } = renderHook(() =>
      useSourceControlSubmoduleRepos({ worktreePath: null, onChanged: vi.fn() })
    )
    expect(gitApi.submoduleRepos).not.toHaveBeenCalled()
    expect(result.current.repos).toEqual([])
  })

  it('runs an action on the named submodule, then reloads and refreshes the parent', async () => {
    const onChanged = vi.fn()
    const { result } = renderHook(() =>
      useSourceControlSubmoduleRepos({ worktreePath: '/repo', onChanged })
    )
    await waitFor(() => expect(result.current.repos).toEqual([REPO]))

    await act(async () => {
      await result.current.runAction('libs/sub', 'pull')
    })

    expect(gitApi.pull).toHaveBeenCalledWith({ worktreePath: '/repo', submodulePath: 'libs/sub' })
    expect(gitApi.submoduleRepos).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBeNull()
  })

  it('shows the git error and still reloads when an action fails', async () => {
    gitApi.push.mockRejectedValue(new Error('rejected: non-fast-forward'))
    const onChanged = vi.fn()
    const { result } = renderHook(() =>
      useSourceControlSubmoduleRepos({ worktreePath: '/repo', onChanged })
    )
    await waitFor(() => expect(result.current.repos).toEqual([REPO]))

    await act(async () => {
      await result.current.runAction('libs/sub', 'push')
    })

    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('non-fast-forward'))
    expect(gitApi.submoduleRepos).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps the new worktree list when the old worktree answers late', async () => {
    let resolveOld: (repos: GitSubmoduleRepo[]) => void = () => {}
    gitApi.submoduleRepos
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValue([REPO])
    const { result, rerender } = renderHook(
      ({ worktreePath }) => useSourceControlSubmoduleRepos({ worktreePath, onChanged: vi.fn() }),
      { initialProps: { worktreePath: '/old' } }
    )
    rerender({ worktreePath: '/new' })
    await waitFor(() => expect(result.current.repos).toEqual([REPO]))

    await act(async () => {
      resolveOld([])
    })

    expect(result.current.repos).toEqual([REPO])
  })
})

describe('submoduleReposWorktreePath', () => {
  const local = {
    worktreePath: '/repo',
    isFolder: false,
    activeRepoTarget: { kind: 'local' },
    activeConnectionId: null
  } as const

  it('serves a git worktree on this machine', () => {
    expect(submoduleReposWorktreePath(local)).toBe('/repo')
  })

  it.each([
    ['a folder workspace', { ...local, isFolder: true }],
    ['an SSH connection', { ...local, activeConnectionId: 'ssh-1' }],
    [
      'a paired server',
      { ...local, activeRepoTarget: { kind: 'environment', environmentId: 'env-1' } }
    ],
    ['an unresolved owner', { ...local, activeRepoTarget: null }]
  ] as const)('serves nothing for %s', (_label, input) => {
    expect(submoduleReposWorktreePath(input)).toBeNull()
  })
})
