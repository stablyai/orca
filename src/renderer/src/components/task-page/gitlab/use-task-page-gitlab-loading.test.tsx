// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'

import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: rpc.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import { gitLabListQueryKey, useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

const serverRepo: Repo = {
  id: 'server-repo',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:build-box'
}
const glListIssues = vi.fn()
const LIST_STATE = {
  gitlabItems: [],
  gitlabError: null,
  gitlabLoading: false,
  displayedGitLabItems: [],
  gitlabListQueryKey: null,
  setGitlabListQueryKey: vi.fn()
}

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [{ id: 'i1', updatedAt: '2026-10-01' }] })
  glListIssues.mockReset().mockRejectedValue(new Error('Access denied: unknown repository path'))
  Object.assign(window, { api: { gl: { listIssues: glListIssues } } })
})

afterEach(cleanup)

describe('useTaskPageGitLabLoading', () => {
  it("never shows the previous filter's rows while a changed filter loads", () => {
    rpc.call.mockReturnValue(new Promise(() => {}))
    const row: GitLabWorkItem = {
      id: 'mr-1',
      type: 'mr',
      number: 1,
      title: 'Someone else',
      state: 'opened',
      url: 'https://gitlab.com/group/app/-/merge_requests/1',
      labels: [],
      updatedAt: '2026-10-01T00:00:00Z',
      author: null,
      repoId: 'server-repo'
    }
    const everyoneKey = gitLabListQueryKey('mrs', 'opened', null, 'server-repo')
    const initialProps: { involvement: 'authored' | null; nonce: number } = {
      involvement: null,
      nonce: 0
    }
    const { result, rerender } = renderHook(
      ({ involvement, nonce }: { involvement: 'authored' | null; nonce: number }) =>
        useTaskPageGitLabLoading({
          selectedRepos: [serverRepo],
          selectedReposKey: 'server-repo',
          primaryRepo: serverRepo,
          taskSource: 'gitlab',
          setGitlabItems: vi.fn(),
          setGitlabLoading: vi.fn(),
          setGitlabError: vi.fn(),
          gitlabRefreshNonce: nonce,
          gitlabView: 'mrs',
          setGitlabTodos: vi.fn(),
          setGitlabTodosLoading: vi.fn(),
          activeGitlabFilter: 'opened',
          gitlabMRInvolvement: involvement,
          ...LIST_STATE,
          gitlabItems: [row],
          displayedGitLabItems: [row],
          gitlabListQueryKey: everyoneKey
        }),
      { initialProps }
    )

    rerender({ involvement: null, nonce: 1 })
    expect(result.current.displayedGitLabItems).toEqual([row])

    rerender({ involvement: 'authored', nonce: 2 })
    expect(result.current.displayedGitLabItems).toEqual([])
    expect(result.current.gitlabLoading).toBe(true)
  })
})
