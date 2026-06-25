/* eslint-disable max-lines -- Why: runtime Linear routing cases stay together
   so local preload fallback and SSH runtime transport parity are reviewed as one boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linearCreateIssue,
  linearCreateProject,
  linearCreateSubIssue,
  linearGetCustomView,
  linearGetProject,
  linearListCustomViewIssues,
  linearListCustomViewProjects,
  linearListCustomViews,
  linearListProjectIssues,
  linearListProjects,
  linearListTeams,
  linearListIssues,
  linearSearchIssues,
  linearSelectWorkspace,
  linearStatus,
  linearUpdateIssue
} from './runtime-linear-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const linearStatusLocal = vi.fn()
const linearSearchIssuesLocal = vi.fn()
const linearListIssuesLocal = vi.fn()
const linearCreateIssueLocal = vi.fn()
const linearCreateProjectLocal = vi.fn()
const linearUpdateIssueLocal = vi.fn()
const linearListTeamsLocal = vi.fn()
const linearListProjectsLocal = vi.fn()
const linearGetCustomViewLocal = vi.fn()
const linearGetProjectLocal = vi.fn()
const linearListProjectIssuesLocal = vi.fn()
const linearListCustomViewsLocal = vi.fn()
const linearListCustomViewIssuesLocal = vi.fn()
const linearListCustomViewProjectsLocal = vi.fn()
const linearSelectWorkspaceLocal = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  linearStatusLocal.mockReset()
  linearSearchIssuesLocal.mockReset()
  linearListIssuesLocal.mockReset()
  linearCreateIssueLocal.mockReset()
  linearCreateProjectLocal.mockReset()
  linearUpdateIssueLocal.mockReset()
  linearListTeamsLocal.mockReset()
  linearListProjectsLocal.mockReset()
  linearGetCustomViewLocal.mockReset()
  linearGetProjectLocal.mockReset()
  linearListProjectIssuesLocal.mockReset()
  linearListCustomViewsLocal.mockReset()
  linearListCustomViewIssuesLocal.mockReset()
  linearListCustomViewProjectsLocal.mockReset()
  linearSelectWorkspaceLocal.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
      linear: {
        status: linearStatusLocal,
        searchIssues: linearSearchIssuesLocal,
        listIssues: linearListIssuesLocal,
        createIssue: linearCreateIssueLocal,
        createProject: linearCreateProjectLocal,
        updateIssue: linearUpdateIssueLocal,
        listTeams: linearListTeamsLocal,
        listProjects: linearListProjectsLocal,
        getCustomView: linearGetCustomViewLocal,
        getProject: linearGetProjectLocal,
        listProjectIssues: linearListProjectIssuesLocal,
        listCustomViews: linearListCustomViewsLocal,
        listCustomViewIssues: linearListCustomViewIssuesLocal,
        listCustomViewProjects: linearListCustomViewProjectsLocal,
        selectWorkspace: linearSelectWorkspaceLocal
      }
    }
  })
})

describe('runtime linear client', () => {
  it('uses local Linear IPC when no runtime environment is active', async () => {
    linearStatusLocal.mockResolvedValue({ connected: false, viewer: null })
    linearSearchIssuesLocal.mockResolvedValue([{ id: 'issue-1' }])
    linearListIssuesLocal.mockResolvedValue({ items: [{ id: 'issue-2' }], hasMore: true })
    linearCreateIssueLocal.mockResolvedValue({
      ok: true,
      id: 'issue-2',
      identifier: 'ENG-2',
      title: 'Child task',
      url: 'https://linear.app/ENG-2'
    })
    linearCreateProjectLocal.mockResolvedValue({ ok: true, project: { id: 'project-1' } })

    await expect(linearStatus({ activeRuntimeEnvironmentId: null })).resolves.toEqual({
      connected: false,
      viewer: null
    })
    await expect(
      linearSearchIssues({ activeRuntimeEnvironmentId: null }, 'bug', 10)
    ).resolves.toEqual([{ id: 'issue-1' }])
    await expect(
      linearListIssues({ activeRuntimeEnvironmentId: null }, 'all', 72, 'workspace-1')
    ).resolves.toEqual({ items: [{ id: 'issue-2' }], hasMore: true })
    await linearCreateSubIssue(
      { activeRuntimeEnvironmentId: null },
      { parentIssueId: 'issue-1', teamId: 'team-1', title: 'Child task' }
    )
    await linearCreateProject(
      { activeRuntimeEnvironmentId: null },
      { name: 'Roadmap', teamIds: ['team-1'], workspaceId: 'workspace-1' }
    )

    expect(linearStatusLocal).toHaveBeenCalled()
    expect(linearSearchIssuesLocal).toHaveBeenCalledWith({
      query: 'bug',
      limit: 10,
      workspaceId: undefined
    })
    expect(linearListIssuesLocal).toHaveBeenCalledWith({
      filter: 'all',
      limit: 72,
      workspaceId: 'workspace-1'
    })
    expect(linearCreateIssueLocal).toHaveBeenCalledWith({
      parentIssueId: 'issue-1',
      teamId: 'team-1',
      title: 'Child task'
    })
    expect(linearCreateProjectLocal).toHaveBeenCalledWith({
      name: 'Roadmap',
      teamIds: ['team-1'],
      workspaceId: 'workspace-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('wraps legacy local Linear issue list arrays as collection results', async () => {
    linearListIssuesLocal.mockResolvedValue([{ id: 'legacy-issue' }])

    await expect(
      linearListIssues({ activeRuntimeEnvironmentId: null }, 'assigned', 20)
    ).resolves.toEqual({ items: [{ id: 'legacy-issue' }] })
  })

  it('rejects oversized local Linear search queries before IPC', async () => {
    await expect(
      linearSearchIssues(
        { activeRuntimeEnvironmentId: null },
        'secret-token-value'.repeat(1024),
        10
      )
    ).resolves.toEqual([])

    await expect(
      linearListProjects({ activeRuntimeEnvironmentId: null }, 'x'.repeat(9 * 1024), 10)
    ).resolves.toEqual({ items: [] })

    expect(linearSearchIssuesLocal).not.toHaveBeenCalled()
    expect(linearListProjectsLocal).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('does not throw when an older local preload lacks project listing', async () => {
    delete (window.api.linear as { listProjects?: unknown }).listProjects

    await expect(
      linearListProjects({ activeRuntimeEnvironmentId: null }, 'roadmap', 10, 'workspace-1')
    ).resolves.toEqual({ items: [] })
  })

  it('passes forced Linear project and custom-view reads to local IPC', async () => {
    linearListProjectsLocal.mockResolvedValueOnce({ items: [{ id: 'project-1' }] })
    linearGetProjectLocal.mockResolvedValueOnce({ id: 'project-1' })
    linearListProjectIssuesLocal.mockResolvedValueOnce({ items: [{ id: 'issue-1' }] })
    linearListCustomViewsLocal.mockResolvedValueOnce({ items: [{ id: 'view-1' }] })
    linearGetCustomViewLocal.mockResolvedValueOnce({ id: 'view-1' })
    linearListCustomViewIssuesLocal.mockResolvedValueOnce({ items: [{ id: 'issue-2' }] })
    linearListCustomViewProjectsLocal.mockResolvedValueOnce({ items: [{ id: 'project-2' }] })

    await linearListProjects({ activeRuntimeEnvironmentId: null }, 'roadmap', 10, 'workspace-1', {
      force: true
    })
    await linearGetProject({ activeRuntimeEnvironmentId: null }, 'project-1', 'workspace-1', {
      force: true
    })
    await linearListProjectIssues(
      { activeRuntimeEnvironmentId: null },
      'project-1',
      10,
      'workspace-1',
      { force: true }
    )
    await linearListCustomViews(
      { activeRuntimeEnvironmentId: null },
      'project',
      10,
      'workspace-1',
      { force: true }
    )
    await linearGetCustomView(
      { activeRuntimeEnvironmentId: null },
      'view-1',
      'project',
      'workspace-1',
      { force: true }
    )
    await linearListCustomViewIssues(
      { activeRuntimeEnvironmentId: null },
      'view-1',
      10,
      'workspace-1',
      { force: true }
    )
    await linearListCustomViewProjects(
      { activeRuntimeEnvironmentId: null },
      'view-2',
      10,
      'workspace-1',
      { force: true }
    )

    expect(linearListProjectsLocal).toHaveBeenCalledWith({
      query: 'roadmap',
      limit: 10,
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearGetProjectLocal).toHaveBeenCalledWith({
      id: 'project-1',
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearListProjectIssuesLocal).toHaveBeenCalledWith({
      projectId: 'project-1',
      limit: 10,
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearListCustomViewsLocal).toHaveBeenCalledWith({
      model: 'project',
      limit: 10,
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearGetCustomViewLocal).toHaveBeenCalledWith({
      viewId: 'view-1',
      model: 'project',
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearListCustomViewIssuesLocal).toHaveBeenCalledWith({
      viewId: 'view-1',
      limit: 10,
      workspaceId: 'workspace-1',
      force: true
    })
    expect(linearListCustomViewProjectsLocal).toHaveBeenCalledWith({
      viewId: 'view-2',
      limit: 10,
      workspaceId: 'workspace-1',
      force: true
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes Linear reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-status',
        ok: true,
        result: { connected: true, viewer: null },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-search',
        ok: true,
        result: [{ id: 'issue-1' }],
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-list',
        ok: true,
        result: { items: [{ id: 'issue-2' }], hasMore: true },
        _meta: { runtimeId: 'runtime-1' }
      })

    await linearStatus({ activeRuntimeEnvironmentId: 'env-1' })
    await linearSearchIssues({ activeRuntimeEnvironmentId: 'env-1' }, 'bug', 10, 'all')
    await expect(
      linearListIssues({ activeRuntimeEnvironmentId: 'env-1' }, 'all', 72, 'workspace-1')
    ).resolves.toEqual({ items: [{ id: 'issue-2' }], hasMore: true })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'linear.status',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'linear.searchIssues',
      params: { query: 'bug', limit: 10, workspaceId: 'all' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'linear.listIssues',
      params: { filter: 'all', limit: 72, workspaceId: 'workspace-1' },
      timeoutMs: 30_000
    })
    expect(linearStatusLocal).not.toHaveBeenCalled()
    expect(linearSearchIssuesLocal).not.toHaveBeenCalled()
    expect(linearListIssuesLocal).not.toHaveBeenCalled()
  })

  it('wraps legacy remote Linear issue list arrays as collection results', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-list',
      ok: true,
      result: [{ id: 'legacy-issue' }],
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      linearListIssues({ activeRuntimeEnvironmentId: 'env-1' }, 'assigned', 20)
    ).resolves.toEqual({ items: [{ id: 'legacy-issue' }] })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'linear.listIssues',
      params: { filter: 'assigned', limit: 20, workspaceId: undefined },
      timeoutMs: 30_000
    })
  })

  it('falls back to an empty Linear issue collection for malformed list responses', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-list',
      ok: true,
      result: { items: { id: 'not-an-array' }, hasMore: true },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      linearListIssues({ activeRuntimeEnvironmentId: 'env-1' }, 'assigned', 20)
    ).resolves.toEqual({ items: [] })
  })

  it('routes Linear mutations and metadata through the selected runtime environment', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-create',
        ok: true,
        result: {
          ok: true,
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix bug',
          url: 'https://linear.app/ENG-1'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-update',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-subissue',
        ok: true,
        result: {
          ok: true,
          id: 'issue-2',
          identifier: 'ENG-2',
          title: 'Child task',
          url: 'https://linear.app/ENG-2'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-teams',
        ok: true,
        result: [{ id: 'team-1' }],
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-projects',
        ok: true,
        result: { items: [{ id: 'project-1' }] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-create-project',
        ok: true,
        result: { ok: true, project: { id: 'project-2' } },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-select',
        ok: true,
        result: { connected: true, viewer: null },
        _meta: { runtimeId: 'runtime-1' }
      })

    await linearCreateIssue(
      { activeRuntimeEnvironmentId: 'env-1' },
      { teamId: 'team-1', title: 'Fix bug', workspaceId: 'workspace-1' }
    )
    await linearUpdateIssue(
      { activeRuntimeEnvironmentId: 'env-1' },
      'issue-1',
      { estimate: 5, priority: 2 },
      'workspace-1'
    )
    await linearCreateSubIssue(
      { activeRuntimeEnvironmentId: 'env-1' },
      {
        parentIssueId: 'issue-1',
        teamId: 'team-1',
        title: 'Child task',
        workspaceId: 'workspace-1',
        projectId: 'project-1'
      }
    )
    await linearListTeams({ activeRuntimeEnvironmentId: 'env-1' }, 'all')
    await linearListProjects({ activeRuntimeEnvironmentId: 'env-1' }, 'roadmap', 10, 'workspace-1')
    await linearCreateProject(
      { activeRuntimeEnvironmentId: 'env-1' },
      {
        name: 'Roadmap',
        description: 'Summary',
        teamIds: ['team-1'],
        workspaceId: 'workspace-1',
        priority: 2
      }
    )
    await linearSelectWorkspace({ activeRuntimeEnvironmentId: 'env-1' }, 'workspace-1')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'linear.createIssue',
      params: { teamId: 'team-1', title: 'Fix bug', workspaceId: 'workspace-1' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'linear.updateIssue',
      params: {
        id: 'issue-1',
        updates: { estimate: 5, priority: 2 },
        workspaceId: 'workspace-1'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'linear.createIssue',
      params: {
        parentIssueId: 'issue-1',
        teamId: 'team-1',
        title: 'Child task',
        workspaceId: 'workspace-1',
        projectId: 'project-1'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'linear.listTeams',
      params: { workspaceId: 'all' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'linear.listProjects',
      params: { query: 'roadmap', limit: 10, workspaceId: 'workspace-1' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'linear.createProject',
      params: {
        name: 'Roadmap',
        description: 'Summary',
        teamIds: ['team-1'],
        workspaceId: 'workspace-1',
        priority: 2
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'linear.selectWorkspace',
      params: { workspaceId: 'workspace-1' },
      timeoutMs: 15_000
    })
  })

  it('routes Linear project and custom-view reads through the selected runtime environment', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-project',
        ok: true,
        result: { id: 'project-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-project-issues',
        ok: true,
        result: { items: [{ id: 'issue-1' }] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-views',
        ok: true,
        result: { items: [{ id: 'view-1' }] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-view',
        ok: true,
        result: { id: 'view-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-view-issues',
        ok: true,
        result: { items: [{ id: 'issue-2' }] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-view-projects',
        ok: true,
        result: { items: [{ id: 'project-2' }] },
        _meta: { runtimeId: 'runtime-1' }
      })

    await linearGetProject({ activeRuntimeEnvironmentId: 'env-1' }, 'project-1', 'workspace-1', {
      force: true
    })
    await linearListProjectIssues(
      { activeRuntimeEnvironmentId: 'env-1' },
      'project-1',
      10,
      'workspace-1',
      { force: true }
    )
    await linearListCustomViews(
      { activeRuntimeEnvironmentId: 'env-1' },
      'project',
      10,
      'workspace-1',
      { force: true }
    )
    await linearGetCustomView(
      { activeRuntimeEnvironmentId: 'env-1' },
      'view-1',
      'project',
      'workspace-1',
      { force: true }
    )
    await linearListCustomViewIssues(
      { activeRuntimeEnvironmentId: 'env-1' },
      'view-1',
      10,
      'workspace-1',
      { force: true }
    )
    await linearListCustomViewProjects(
      { activeRuntimeEnvironmentId: 'env-1' },
      'view-2',
      10,
      'workspace-1',
      { force: true }
    )

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'linear.getProject',
      params: { id: 'project-1', workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'linear.listProjectIssues',
      params: { projectId: 'project-1', limit: 10, workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'linear.listCustomViews',
      params: { model: 'project', limit: 10, workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'linear.getCustomView',
      params: { viewId: 'view-1', model: 'project', workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'linear.listCustomViewIssues',
      params: { viewId: 'view-1', limit: 10, workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'linear.listCustomViewProjects',
      params: { viewId: 'view-2', limit: 10, workspaceId: 'workspace-1', force: true },
      timeoutMs: 30_000
    })
    expect(linearGetProjectLocal).not.toHaveBeenCalled()
    expect(linearGetCustomViewLocal).not.toHaveBeenCalled()
    expect(linearListProjectIssuesLocal).not.toHaveBeenCalled()
    expect(linearListCustomViewsLocal).not.toHaveBeenCalled()
    expect(linearListCustomViewIssuesLocal).not.toHaveBeenCalled()
    expect(linearListCustomViewProjectsLocal).not.toHaveBeenCalled()
  })
})
