// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'

const state = vi.hoisted(() => {
  const repos: Repo[] = []
  return {
    repos,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    gitStatusByWorktree: {}
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: vi.fn()
}))

afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  state.repos = []
})

describe('delete status snapshot continuity', () => {
  it('keeps loaded paths when catalog objects refresh for the same workspace', async () => {
    vi.mocked(getRuntimeGitStatus)
      .mockResolvedValueOnce({
        entries: [{ path: 'keep-visible.ts', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown'
      })
      .mockImplementation(() => new Promise(() => {}))
    const target = makeWorktree({ id: 'feature', repoId: 'repo', hostId: 'local' })
    const targets = [target]
    const view = renderHook(useDeleteWorktreeStatusHydration, {
      initialProps: {
        isOpen: true,
        deleteTargets: targets,
        visibleTargets: targets,
        repoMap: new Map<string, Repo>()
      }
    })
    await waitFor(() =>
      expect(view.result.current.get('local|feature')).toEqual([
        { path: 'keep-visible.ts', status: 'modified', area: 'unstaged' }
      ])
    )

    state.repos = [...state.repos]
    view.rerender({
      isOpen: true,
      deleteTargets: [{ ...target, lastActivityAt: 42 }],
      visibleTargets: [{ ...target }],
      repoMap: new Map()
    })

    expect(view.result.current.get('local|feature')).toEqual([
      { path: 'keep-visible.ts', status: 'modified', area: 'unstaged' }
    ])
  })

  it('replaces the snapshot when the same host changes its SSH connection', async () => {
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 1,
      executionHostId: 'runtime:fixture',
      connectionId: 'first'
    }
    state.repos = [repo]
    const target = makeWorktree({ id: 'feature', repoId: 'repo', hostId: 'runtime:fixture' })
    let finish: (status: GitStatusResult) => void = () => {
      throw new Error('Status read has not started')
    }
    vi.mocked(getRuntimeGitStatus)
      .mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    const props = {
      isOpen: true,
      deleteTargets: [target],
      visibleTargets: [target],
      repoMap: new Map([['repo', repo]])
    }
    const view = renderHook(useDeleteWorktreeStatusHydration, { initialProps: props })
    await waitFor(() => expect(view.result.current.get('runtime:fixture|feature')).toEqual([]))

    state.repos = [{ ...repo, connectionId: 'second' }]
    view.rerender({ ...props, repoMap: new Map([['repo', state.repos[0]!]]) })
    expect(view.result.current.get('runtime:fixture|feature')).toBeUndefined()
    await act(async () => {
      finish({
        entries: [{ path: 'second-host.ts', status: 'added', area: 'staged' }],
        conflictOperation: 'unknown'
      })
    })
    expect(view.result.current.get('runtime:fixture|feature')).toEqual([
      { path: 'second-host.ts', status: 'added', area: 'staged' }
    ])
  })
})
