import { beforeEach, describe, expect, it, vi } from 'vitest'
import { linearListIssues } from './runtime-linear-client'
import {
  createCompatibleRuntimeStatusResponse,
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
  it('wraps legacy local Linear issue list arrays as collection results', async () => {
    linearListIssuesLocal.mockResolvedValue([{ id: 'legacy-issue' }])

    await expect(linearListIssues({ kind: 'local' }, 'assigned', 20)).resolves.toEqual({
      items: [{ id: 'legacy-issue' }]
    })
  })

  it('rejects filtered reads before an older runtime can return unfiltered issues', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-list',
      ok: true,
      result: { items: [{ id: 'unfiltered-issue' }] },
      _meta: { runtimeId: 'runtime-old' }
    })
    const oldServerStatus = createCompatibleRuntimeStatusResponse('runtime-old')
    if (oldServerStatus.ok) {
      oldServerStatus.result.capabilities = oldServerStatus.result.capabilities?.filter(
        (capability) => capability !== 'linear.issue-attribute-filter.v1'
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldServerStatus : runtimeEnvironmentCall(args)
    )

    await expect(
      linearListIssues({ kind: 'environment', environmentId: 'env-1' }, 'all', 20, 'workspace-1', {
        stateIds: ['state-1'],
        priorities: [],
        assignee: null,
        labelIds: []
      })
    ).rejects.toMatchObject({
      name: 'LinearIssueAttributeFilterUnsupportedError',
      message: 'This remote runtime must be updated to filter Linear issues.'
    })

    expect(runtimeEnvironmentTransportCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('falls back to an empty Linear issue collection for malformed list responses', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-list',
      ok: true,
      result: { items: { id: 'not-an-array' }, hasMore: true },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      linearListIssues({ kind: 'environment', environmentId: 'env-1' }, 'assigned', 20)
    ).resolves.toEqual({ items: [] })
  })
})
