// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GiteaWorkItem } from '../../../../shared/gitea-types'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import { useTaskPageGiteaLoading } from './use-task-page-gitea-loading'

const serverRepo: Repo = {
  id: 'server-repo',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:build-box'
}
const localRepo: Repo = {
  id: 'local-repo',
  path: '/work/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1
}

const giteaApi = {
  listIssues: vi.fn(),
  listPRs: vi.fn(),
  notifications: vi.fn(),
  listLabels: vi.fn(),
  listAssignableUsers: vi.fn()
}

type LoadingInput = Parameters<typeof useTaskPageGiteaLoading>[0]

function loadingInput(overrides: Partial<LoadingInput> = {}): LoadingInput {
  return {
    selectedRepos: [localRepo],
    selectedReposKey: 'local-repo',
    primaryRepo: localRepo,
    taskSource: 'gitea' as const,
    setGiteaItems: vi.fn(),
    setGiteaLoading: vi.fn(),
    setGiteaError: vi.fn(),
    giteaRefreshNonce: 0,
    giteaView: 'prs' as const,
    setGiteaNotifications: vi.fn(),
    setGiteaNotificationsLoading: vi.fn(),
    activeGiteaFilter: 'opened' as const,
    giteaAssigneeFilter: '',
    setGiteaLabels: vi.fn(),
    setGiteaAssignableUsers: vi.fn(),
    ...overrides
  }
}

const pr = (number: number, updatedAt: string): GiteaWorkItem => ({
  id: `pr:${number}`,
  type: 'pr',
  number,
  title: `PR ${number}`,
  state: 'open',
  url: `https://gitea.example/o/r/pulls/${number}`,
  labels: [],
  updatedAt,
  author: null,
  repoId: ''
})

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [] })
  giteaApi.listIssues.mockReset().mockResolvedValue({ items: [] })
  giteaApi.listPRs.mockReset().mockResolvedValue({ items: [] })
  giteaApi.notifications.mockReset().mockResolvedValue([])
  giteaApi.listLabels.mockReset().mockResolvedValue([])
  giteaApi.listAssignableUsers.mockReset().mockResolvedValue([])
  Object.assign(window, { api: { gitea: giteaApi } })
})

afterEach(cleanup)

describe('useTaskPageGiteaLoading', () => {
  it('lists PRs newest first and stamps the returning repo and host', async () => {
    giteaApi.listPRs.mockResolvedValue({
      items: [pr(1, '2026-10-01T00:00:00Z'), pr(2, '2026-10-02T00:00:00Z')]
    })
    const input = loadingInput()
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaLoading).toHaveBeenLastCalledWith(false))
    expect(giteaApi.listPRs).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/work/app', state: 'opened', page: 1, perPage: 50 })
    )
    expect(input.setGiteaItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ number: 2, repoId: 'local-repo', repoHostId: 'local' }),
      expect.objectContaining({ number: 1, repoId: 'local-repo' })
    ])
  })

  it('maps issues into work items and passes the state and assignee filters to the issue list', async () => {
    giteaApi.listIssues.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Crash',
          body: '',
          state: 'open',
          url: 'https://gitea.example/o/r/issues/7',
          author: 'sam',
          labels: ['bug'],
          assignees: [],
          updatedAt: '2026-10-03T00:00:00Z'
        }
      ]
    })
    const input = loadingInput({
      giteaView: 'issues',
      activeGiteaFilter: 'closed',
      giteaAssigneeFilter: 'sam'
    })
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaItems).toHaveBeenCalled())
    expect(giteaApi.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: 'sam', state: 'closed', limit: 50 })
    )
    expect(input.setGiteaItems).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'issue:7',
        type: 'issue',
        number: 7,
        labels: ['bug'],
        repoId: 'local-repo'
      })
    ])
  })

  it('lists a server-owned repo on its server', async () => {
    rpc.call.mockResolvedValue({ items: [pr(3, '2026-10-01T00:00:00Z')] })
    const input = loadingInput({
      selectedRepos: [serverRepo],
      selectedReposKey: 'server-repo',
      primaryRepo: serverRepo
    })
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaItems).toHaveBeenCalled())
    expect(giteaApi.listPRs).not.toHaveBeenCalled()
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'build-box' },
      'gitea.listPRs',
      expect.objectContaining({ repo: 'id:server-repo', state: 'opened' }),
      expect.anything()
    )
    expect(input.setGiteaItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ number: 3, repoHostId: 'runtime:build-box' })
    ])
  })

  it('hides not_found from non-Gitea repos but surfaces other failures when nothing loaded', async () => {
    giteaApi.listPRs.mockResolvedValueOnce({
      items: [],
      error: { type: 'not_found', message: 'No Gitea repository found.' }
    })
    const quiet = loadingInput()
    renderHook(() => useTaskPageGiteaLoading(quiet))
    await waitFor(() => expect(quiet.setGiteaLoading).toHaveBeenLastCalledWith(false))
    expect(quiet.setGiteaError).not.toHaveBeenCalledWith('No Gitea repository found.')

    giteaApi.listPRs.mockResolvedValueOnce({
      items: [],
      error: { type: 'auth_required', message: 'Sign in to Gitea.' }
    })
    const failing = loadingInput({ giteaRefreshNonce: 1 })
    renderHook(() => useTaskPageGiteaLoading(failing))
    await waitFor(() => expect(failing.setGiteaError).toHaveBeenCalledWith('Sign in to Gitea.'))
  })

  it('loads notifications for the primary repo without touching the item lists', async () => {
    const notification = {
      id: 1,
      subjectType: 'Issue',
      subjectTitle: 'Fix it',
      subjectUrl: 'https://gitea.example/o/r/issues/1',
      subjectNumber: 1,
      repositoryPath: 'o/r',
      updatedAt: '2026-10-01T00:00:00Z',
      unread: true
    }
    giteaApi.notifications.mockResolvedValue([notification])
    const input = loadingInput({ giteaView: 'notifications' })
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaNotifications).toHaveBeenCalledWith([notification]))
    expect(giteaApi.listPRs).not.toHaveBeenCalled()
    expect(giteaApi.listIssues).not.toHaveBeenCalled()
  })

  it('loads repo labels and assignable users for the filter dropdowns', async () => {
    giteaApi.listLabels.mockResolvedValue(['bug', 'ui'])
    giteaApi.listAssignableUsers.mockResolvedValue([{ username: 'sam', name: null, avatarUrl: '' }])
    const input = loadingInput({ giteaView: 'issues' })
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaLabels).toHaveBeenCalledWith(['bug', 'ui']))
    expect(input.setGiteaAssignableUsers).toHaveBeenCalledWith([
      { username: 'sam', name: null, avatarUrl: '' }
    ])
  })

  it('leaves the dropdowns empty when label loading fails', async () => {
    giteaApi.listLabels.mockRejectedValue(new Error('offline'))
    const input = loadingInput()
    renderHook(() => useTaskPageGiteaLoading(input))

    await waitFor(() => expect(input.setGiteaLabels).toHaveBeenCalledWith([]))
  })

  it('does nothing while another provider is active', () => {
    const input = loadingInput({ taskSource: 'github' })
    renderHook(() => useTaskPageGiteaLoading(input))
    expect(giteaApi.listPRs).not.toHaveBeenCalled()
    expect(input.setGiteaLoading).not.toHaveBeenCalled()
  })
})
