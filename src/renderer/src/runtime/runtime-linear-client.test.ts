import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linearCreateIssue,
  linearListTeams,
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
const linearCreateIssueLocal = vi.fn()
const linearUpdateIssueLocal = vi.fn()
const linearListTeamsLocal = vi.fn()
const linearSelectWorkspaceLocal = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  linearStatusLocal.mockReset()
  linearSearchIssuesLocal.mockReset()
  linearCreateIssueLocal.mockReset()
  linearUpdateIssueLocal.mockReset()
  linearListTeamsLocal.mockReset()
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
        createIssue: linearCreateIssueLocal,
        updateIssue: linearUpdateIssueLocal,
        listTeams: linearListTeamsLocal,
        selectWorkspace: linearSelectWorkspaceLocal
      }
    }
  })
})

describe('runtime linear client', () => {
  it('uses local Linear IPC when no runtime environment is active', async () => {
    linearStatusLocal.mockResolvedValue({ connected: false, viewer: null })
    linearSearchIssuesLocal.mockResolvedValue([{ id: 'issue-1' }])

    await expect(linearStatus({ activeRuntimeEnvironmentId: null })).resolves.toEqual({
      connected: false,
      viewer: null
    })
    await expect(
      linearSearchIssues({ activeRuntimeEnvironmentId: null }, 'bug', 10)
    ).resolves.toEqual([{ id: 'issue-1' }])

    expect(linearStatusLocal).toHaveBeenCalled()
    expect(linearSearchIssuesLocal).toHaveBeenCalledWith({
      query: 'bug',
      limit: 10,
      workspaceId: undefined
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

    await linearStatus({ activeRuntimeEnvironmentId: 'env-1' })
    await linearSearchIssues({ activeRuntimeEnvironmentId: 'env-1' }, 'bug', 10, 'all')

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
    expect(linearStatusLocal).not.toHaveBeenCalled()
    expect(linearSearchIssuesLocal).not.toHaveBeenCalled()
  })

  it('routes Linear mutations and metadata through the selected runtime environment', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-create',
        ok: true,
        result: { ok: true, id: 'issue-1', identifier: 'ENG-1', url: 'https://linear.app/ENG-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-update',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-teams',
        ok: true,
        result: [{ id: 'team-1' }],
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
      { priority: 2 },
      'workspace-1'
    )
    await linearListTeams({ activeRuntimeEnvironmentId: 'env-1' }, 'all')
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
      params: { id: 'issue-1', updates: { priority: 2 }, workspaceId: 'workspace-1' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'linear.listTeams',
      params: { workspaceId: 'all' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'linear.selectWorkspace',
      params: { workspaceId: 'workspace-1' },
      timeoutMs: 15_000
    })
  })
})
