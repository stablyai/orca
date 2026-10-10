// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

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
})
