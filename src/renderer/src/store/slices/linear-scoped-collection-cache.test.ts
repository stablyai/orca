import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearProjectDetail } from '../../../../shared/linear/project-types'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { createTestStore, deferred, issue, project } from './linear-slice-test-harness'

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

  it('surfaces scoped project issue failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearProjectIssueCache: {
        'workspace-1::project-issues::project-1::20': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: 1
        }
      }
    })
    linearListProjectIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 20, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
    expect(linearListProjectIssues.mock.calls[0][4]).toEqual({ force: true })
  })

  it('falls back to the largest smaller cached project issue limit when expansion fails', async () => {
    const store = createTestStore()
    store.setState({
      linearProjectIssueCache: {
        'workspace-1::project-issues::project-1::20': {
          data: { items: [issue('LIN-SMALLER')] },
          fetchedAt: 1
        },
        'workspace-1::project-issues::project-1::36': {
          data: { items: [issue('LIN-CACHED-36')] },
          fetchedAt: 1
        },
        'workspace-1::project-issues::project-2::36': {
          data: { items: [issue('LIN-OTHER-PROJECT')] },
          fetchedAt: 1
        },
        'workspace-2::project-issues::project-1::36': {
          data: { items: [issue('LIN-OTHER-WORKSPACE')] },
          fetchedAt: 1
        }
      }
    })
    linearListProjectIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 72, {
        force: true
      })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED-36' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
    expect(linearListProjectIssues.mock.calls[0][2]).toBe(72)
  })

  it('caches project issue reads by the expanded effective limit', async () => {
    const store = createTestStore()
    linearListProjectIssues.mockResolvedValueOnce({ items: [issue('LIN-120')], hasMore: true })

    await expect(
      store.getState().listLinearProjectIssues('project-1', 'workspace-1', 120)
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-120' }],
      hasMore: true
    })

    expect(linearListProjectIssues).toHaveBeenCalledWith(null, 'project-1', 120, 'workspace-1', {
      force: undefined
    })
    expect(
      store.getState().linearProjectIssueCache['workspace-1::project-issues::project-1::120']?.data
    ).toMatchObject({ items: [{ id: 'LIN-120' }] })
  })

  it('surfaces scoped custom-view project failures alongside cached rows', async () => {
    const store = createTestStore()
    const rateLimitError = Object.assign(new Error('slow down'), { status: 429 })
    store.setState({
      linearCustomViewProjectCache: {
        'workspace-1::custom-view-projects::view-1::20': {
          data: { items: [project('project-cached')] },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViewProjects.mockRejectedValueOnce(rateLimitError)

    await expect(
      store.getState().listLinearCustomViewProjects('view-1', 'workspace-1', 20, {
        force: true
      })
    ).resolves.toMatchObject({
      items: [{ id: 'project-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'rate_limited', message: 'slow down' }]
    })
    expect(linearListCustomViewProjects.mock.calls[0][4]).toEqual({ force: true })
  })

  it('surfaces scoped custom-view issue failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearCustomViewIssueCache: {
        'workspace-1::custom-view-issues::view-1::20': {
          data: { items: [issue('LIN-CACHED')] },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViewIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearCustomViewIssues('view-1', 'workspace-1', 20, {
        force: true
      })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
    expect(linearListCustomViewIssues.mock.calls[0][4]).toEqual({ force: true })
  })

  it('falls back to the largest smaller cached custom-view issue limit when expansion fails', async () => {
    const store = createTestStore()
    store.setState({
      linearCustomViewIssueCache: {
        'workspace-1::custom-view-issues::view-1::20': {
          data: { items: [issue('LIN-SMALLER')] },
          fetchedAt: 1
        },
        'workspace-1::custom-view-issues::view-1::36': {
          data: { items: [issue('LIN-CACHED-36')] },
          fetchedAt: 1
        },
        'workspace-1::custom-view-issues::view-2::36': {
          data: { items: [issue('LIN-OTHER-VIEW')] },
          fetchedAt: 1
        },
        'workspace-2::custom-view-issues::view-1::36': {
          data: { items: [issue('LIN-OTHER-WORKSPACE')] },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViewIssues.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearCustomViewIssues('view-1', 'workspace-1', 72, {
        force: true
      })
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-CACHED-36' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
    expect(linearListCustomViewIssues.mock.calls[0][2]).toBe(72)
  })

  it('caches issue custom-view reads by the expanded effective limit', async () => {
    const store = createTestStore()
    linearListCustomViewIssues.mockResolvedValueOnce({ items: [issue('LIN-120')], hasMore: true })

    await expect(
      store.getState().listLinearCustomViewIssues('view-1', 'workspace-1', 120)
    ).resolves.toMatchObject({
      items: [{ id: 'LIN-120' }],
      hasMore: true
    })

    expect(linearListCustomViewIssues).toHaveBeenCalledWith(null, 'view-1', 120, 'workspace-1', {
      force: undefined
    })
    expect(
      store.getState().linearCustomViewIssueCache['workspace-1::custom-view-issues::view-1::120']
        ?.data
    ).toMatchObject({ items: [{ id: 'LIN-120' }] })
  })

  it('surfaces top-level project list failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearProjectCache: {
        'workspace-1::projects::::20': {
          data: { items: [project('project-cached')] },
          fetchedAt: 1
        }
      }
    })
    linearListProjects.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearProjects(undefined, 20, undefined, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'project-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
  })

  it('surfaces top-level custom-view failures alongside cached rows', async () => {
    const store = createTestStore()
    store.setState({
      linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' },
      linearCustomViewCache: {
        'workspace-1::custom-views::project::20': {
          data: {
            items: [{ id: 'view-cached', name: 'Cached view', model: 'project' }]
          },
          fetchedAt: 1
        }
      }
    })
    linearListCustomViews.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().listLinearCustomViews('project', 20, undefined, { force: true })
    ).resolves.toMatchObject({
      items: [{ id: 'view-cached' }],
      errors: [{ workspaceId: 'workspace-1', type: 'unknown', message: 'network down' }]
    })
    expect(linearListCustomViews.mock.calls[0][4]).toEqual({ force: true })
  })

  it('fetches custom views by exact id and clears stale credential errors', async () => {
    const store = createTestStore()
    const staleError = credentialDecryptionMessage('Linear')
    store.setState({
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'workspace-1',
        credentialError: staleError
      }
    })
    linearGetCustomView.mockResolvedValueOnce({
      id: 'view-1',
      name: 'Burn views',
      model: 'project',
      workspaceId: 'workspace-1'
    })
    linearStatus.mockResolvedValueOnce({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    })

    await expect(
      store.getState().fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })
    ).resolves.toMatchObject({ id: 'view-1' })

    expect(linearGetCustomView).toHaveBeenCalledWith(null, 'view-1', 'project', 'workspace-1', {
      force: true
    })
    await vi.waitFor(() => {
      expect(store.getState().linearStatus.credentialError).toBeUndefined()
    })
  })

  it('fails forced exact custom-view validation instead of reopening stale cache', async () => {
    const store = createTestStore()
    store.setState({
      linearCustomViewDetailCache: {
        'workspace-1::custom-view-detail::project::view-1': {
          data: {
            id: 'view-1',
            name: 'Stale view',
            model: 'project',
            workspaceId: 'workspace-1'
          },
          fetchedAt: 1
        }
      }
    })
    linearGetCustomView.mockRejectedValueOnce(new Error('network down'))

    await expect(
      store.getState().fetchLinearCustomView('view-1', 'workspace-1', 'project', { force: true })
    ).rejects.toThrow('network down')
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
