import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import type { ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

const emptyWorkItems: ListWorkItemsResult<never> = {
  items: [],
  sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
}

describe('GitHub provider request concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('shares eight FIFO slots across work items and Projects and hands off after rejection', async () => {
    const store = createTestStore()
    const workRequests = Array.from({ length: 9 }, () =>
      Promise.withResolvers<ListWorkItemsResult<never>>()
    )
    let workCall = 0
    mockApi.gh.listWorkItems.mockImplementation(() => workRequests[workCall++].promise)
    const projectRequest = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable.mockReturnValueOnce(projectRequest.promise)

    const activeWork = Array.from({ length: 8 }, (_, index) =>
      store
        .getState()
        .fetchWorkItems(`repo-${index}`, `/repo/${index}`, 20, '')
        .catch(() => [])
    )
    const queuedProject = store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })
    const queuedWork = store
      .getState()
      .fetchWorkItems('repo-queued', '/repo/queued', 20, '')
      .catch(() => [])
    await Promise.resolve()

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(8)
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()

    workRequests[0].reject(new Error('first request failed'))
    await activeWork[0]
    await Promise.resolve()
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(8)

    projectRequest.resolve({
      ok: false,
      error: { type: 'network_error', message: 'project failed' }
    })
    await queuedProject
    await Promise.resolve()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(9)

    for (const request of workRequests.slice(1)) {
      request.resolve(emptyWorkItems)
    }
    await Promise.all([...activeWork.slice(1), queuedWork])
  })
})
