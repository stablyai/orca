// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  GITLAB_TASK_FETCH_CONCURRENCY,
  useTaskPageGitLabLoading
} from './use-task-page-gitlab-loading'

const serverRepo: Repo = {
  id: 'server-repo',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:build-box'
}
const glListIssues = vi.fn()

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [{ id: 'i1', updatedAt: '2026-10-01' }] })
  glListIssues.mockReset().mockRejectedValue(new Error('Access denied: unknown repository path'))
  Object.assign(window, { api: { gl: { listIssues: glListIssues } } })
})

afterEach(cleanup)

describe('useTaskPageGitLabLoading', () => {
  it('lists a server-owned repo on its server (#14603)', async () => {
    const setGitlabItems = vi.fn()
    const setGitlabError = vi.fn()
    renderHook(() =>
      useTaskPageGitLabLoading({
        selectedRepos: [serverRepo],
        selectedReposKey: 'server-repo',
        primaryRepo: serverRepo,
        taskSource: 'gitlab',
        setGitlabItems,
        setGitlabLoading: vi.fn(),
        setGitlabError,
        gitlabRefreshNonce: 0,
        gitlabView: 'issues',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened'
      })
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(glListIssues).not.toHaveBeenCalled()
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'build-box' },
      'gitlab.listIssues',
      expect.objectContaining({ repo: 'id:server-repo', state: 'opened' }),
      expect.anything()
    )
    expect(setGitlabItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'i1', repoId: 'server-repo' })
    ])
    expect(setGitlabError).not.toHaveBeenCalledWith(expect.stringContaining('Access denied'))
  })

  function manyServerRepos(count: number): Repo[] {
    return Array.from({ length: count }, (_, i) => ({
      ...serverRepo,
      id: `server-repo-${i}`,
      path: `/srv/app-${i}`,
      displayName: `app-${i}`
    }))
  }

  function renderIssuesHook(repos: Repo[], setGitlabItems = vi.fn()) {
    return renderHook(() =>
      useTaskPageGitLabLoading({
        selectedRepos: repos,
        selectedReposKey: repos.map((repo) => repo.id).join(','),
        primaryRepo: repos[0],
        taskSource: 'gitlab',
        setGitlabItems,
        setGitlabLoading: vi.fn(),
        setGitlabError: vi.fn(),
        gitlabRefreshNonce: 0,
        gitlabView: 'issues',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened'
      })
    )
  }

  it('bounds concurrent per-repo GitLab calls for large all-projects selections (#30133)', async () => {
    const repos = manyServerRepos(20)
    let inFlight = 0
    let maxInFlight = 0
    rpc.call.mockImplementation(async (_target, _method, params: { repo: string }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return { items: [{ id: `item-${params.repo}`, updatedAt: '2026-10-01' }] }
    })
    const setGitlabItems = vi.fn()

    renderIssuesHook(repos, setGitlabItems)

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(rpc.call).toHaveBeenCalledTimes(repos.length)
    expect(maxInFlight).toBe(GITLAB_TASK_FETCH_CONCURRENCY)
    expect(setGitlabItems.mock.lastCall?.[0]).toHaveLength(repos.length)
    expect(setGitlabItems).toHaveBeenLastCalledWith(
      expect.arrayContaining(repos.map((repo) => expect.objectContaining({ repoId: repo.id })))
    )
  })

  it("stamps each twin row's items with the host that returned them", async () => {
    const twinOnOtherServer: Repo = { ...serverRepo, executionHostId: 'runtime:other-box' }
    rpc.call.mockImplementation(async (target: { environmentId: string }) => ({
      items: [{ id: `issue-on-${target.environmentId}`, updatedAt: '2026-10-01' }]
    }))
    const setGitlabItems = vi.fn()

    renderIssuesHook([serverRepo, twinOnOtherServer], setGitlabItems)

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(setGitlabItems.mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'issue-on-build-box',
          repoId: 'server-repo',
          repoHostId: 'runtime:build-box'
        }),
        expect.objectContaining({
          id: 'issue-on-other-box',
          repoId: 'server-repo',
          repoHostId: 'runtime:other-box'
        })
      ])
    )
  })

  it('stops starting GitLab calls once the selection goes stale (#30133)', async () => {
    const repos = manyServerRepos(20)
    const pending: (() => void)[] = []
    rpc.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ items: [] }))
        })
    )
    const setGitlabItems = vi.fn()

    const { unmount } = renderIssuesHook(repos, setGitlabItems)

    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(GITLAB_TASK_FETCH_CONCURRENCY))
    unmount()
    for (const resolve of pending.splice(0)) {
      resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rpc.call).toHaveBeenCalledTimes(GITLAB_TASK_FETCH_CONCURRENCY)
    expect(setGitlabItems).not.toHaveBeenCalled()
  })
})
