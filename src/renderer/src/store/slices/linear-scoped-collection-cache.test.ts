import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearProjectDetail } from '../../../../shared/linear/project-types'
import '../../../../shared/integration-credential-errors'
import { createTestStore, deferred, project } from './linear-slice-test-harness'

const linearStatus = vi.fn()
const linearConnect = vi.fn()
const linearDisconnect = vi.fn()
const linearListIssues = vi.fn()
const linearSearchIssues = vi.fn()
const linearListTeams = vi.fn()
const linearGetIssue = vi.fn()
const linearListProjects = vi.fn()
const linearGetCustomView = vi.fn()
const linearGetProject = vi.fn()
const linearListProjectIssues = vi.fn()
const linearListCustomViews = vi.fn()
const linearListCustomViewIssues = vi.fn()
const linearListCustomViewProjects = vi.fn()
const linearTestConnection = vi.fn()

vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearConnect: (...args: unknown[]) => linearConnect(...args),
    linearDisconnect: (...args: unknown[]) => linearDisconnect(...args),
    linearDisconnectWorkspace: vi.fn(),
    linearListIssues: (...args: unknown[]) => linearListIssues(...args),
    linearSearchIssues: (...args: unknown[]) => linearSearchIssues(...args),
    linearSelectWorkspace: vi.fn(),
    linearStatus: (...args: unknown[]) => linearStatus(...args),
    linearTestConnection: (...args: unknown[]) => linearTestConnection(...args)
  }
})

vi.mock('@/runtime/runtime-linear-issue-mutations', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearGetIssue: (...args: unknown[]) => linearGetIssue(...args)
  }
})

vi.mock('@/runtime/runtime-linear-project-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    linearGetCustomView: (...args: unknown[]) => linearGetCustomView(...args),
    linearGetProject: (...args: unknown[]) => linearGetProject(...args),
    linearListCustomViewIssues: (...args: unknown[]) => linearListCustomViewIssues(...args),
    linearListCustomViewProjects: (...args: unknown[]) => linearListCustomViewProjects(...args),
    linearListCustomViews: (...args: unknown[]) => linearListCustomViews(...args),
    linearListProjectIssues: (...args: unknown[]) => linearListProjectIssues(...args),
    linearListProjects: (...args: unknown[]) => linearListProjects(...args),
    linearListTeams: (...args: unknown[]) => linearListTeams(...args)
  }
})

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

describe('createLinearSlice caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prevents stale detail reads from overwriting forced refresh caches', async () => {
    const store = createTestStore()
    const staleProject = deferred<LinearProjectDetail | null>()
    const freshProject = deferred<LinearProjectDetail | null>()
    const staleView = deferred<{
      id: string
      name: string
      model: 'project'
      workspaceId: string
    }>()
    const freshView = deferred<{
      id: string
      name: string
      model: 'project'
      workspaceId: string
    }>()
    linearGetProject
      .mockReturnValueOnce(staleProject.promise)
      .mockReturnValueOnce(freshProject.promise)
    linearGetCustomView
      .mockReturnValueOnce(staleView.promise)
      .mockReturnValueOnce(freshView.promise)

    const staleProjectPromise = store.getState().fetchLinearProject('project-1', 'workspace-1')
    const freshProjectPromise = store
      .getState()
      .fetchLinearProject('project-1', 'workspace-1', { force: true })
    const staleViewPromise = store
      .getState()
      .fetchLinearCustomView('view-1', 'workspace-1', 'project')
    const freshViewPromise = store
      .getState()
      .fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })

    freshProject.resolve({ ...project('project-1'), name: 'Fresh project' })
    freshView.resolve({
      id: 'view-1',
      name: 'Fresh view',
      model: 'project',
      workspaceId: 'workspace-1'
    })
    await freshProjectPromise
    await freshViewPromise

    staleProject.resolve({ ...project('project-1'), name: 'Stale project' })
    staleView.resolve({
      id: 'view-1',
      name: 'Stale view',
      model: 'project',
      workspaceId: 'workspace-1'
    })
    await staleProjectPromise
    await staleViewPromise

    expect(
      store.getState().linearProjectDetailCache['workspace-1::project-detail::project-1'].data?.name
    ).toBe('Fresh project')
    expect(
      store.getState().linearCustomViewDetailCache[
        'workspace-1::custom-view-detail::project::view-1'
      ].data?.name
    ).toBe('Fresh view')
  })
})
