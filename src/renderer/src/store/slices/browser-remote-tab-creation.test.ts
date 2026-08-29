import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks,
  runtimeStatuses,
  settingsWithRuntime
} from './browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice runtime guard', () => {
  beforeEach(() => {
    resetBrowserRuntimeMocks({
      runtimeEnvironmentCall,
      runtimeEnvironmentTransportCall,
      createWebRuntimeSessionBrowserTabMock
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects direct client-local materialization in the web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const store = createTestStore()

    expect(() => store.getState().createBrowserTab('wt-1', 'about:blank')).toThrow(
      'must be created by a capable paired runtime'
    )
    expect(store.getState().browserTabsByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })

  it('rejects direct remote materialization without the provider capability', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const store = createTestStore()
    store.setState({ runtimeStatusByEnvironmentId: runtimeStatuses([]) })

    expect(() =>
      store.getState().createBrowserTab('wt-1', 'about:blank', {
        browserRuntimeEnvironmentId: 'env-1'
      })
    ).toThrow('paired runtime does not support browser streaming')
    expect(store.getState().browserTabsByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })

  it('creates new browser tabs through the owning runtime for desktop remote worktrees', async () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1']),
      browserDefaultUrl: 'about:blank',
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            path: '/repo/wt',
            head: 'abc123',
            branch: 'feature',
            isBare: false,
            isMainWorktree: false,
            displayName: 'Workspace',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1
          }
        ]
      }
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      environmentId: 'env-1',
      url: 'about:blank',
      targetGroupId: 'group-1',
      // Why: desktop pane groups are client-owned; without the client group the local
      // reconciler lands the new tab in the first group.
      clientTargetGroupId: 'group-1'
    })
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
  })

  it('uses the desktop client browser when a remote npm host cannot stream', async () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: settingsWithRuntime('env-1'),
      runtimeStatusByEnvironmentId: runtimeStatuses([]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    const tab = store.getState().browserTabsByWorktree['wt-remote']?.[0]
    const page = tab ? store.getState().browserPagesByWorkspace[tab.id]?.[0] : undefined
    expect(page?.browserRuntimeEnvironmentId).toBeNull()
    expect(store.getState().createUnifiedTab).toHaveBeenCalled()
  })

  it('does not create a local fallback tab when remote browser creation fails', async () => {
    const store = createTestStore()
    // Why: a remote-owned workspace must stay remote-owned. If the remote host
    // cannot create the page, we must NOT silently open a local desktop tab —
    // that produces confusing split ownership (issue #5321 UX requirement).
    createWebRuntimeSessionBrowserTabMock.mockResolvedValueOnce(false)
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1']),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await expect(store.getState().openNewBrowserTabInActiveWorkspace('group-1')).rejects.toThrow(
      'The paired runtime could not create a managed browser tab.'
    )

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      environmentId: 'env-1',
      url: 'about:blank',
      targetGroupId: 'group-1',
      clientTargetGroupId: 'group-1'
    })
    // No local tab created, no unified tab, no feature interaction recorded.
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )
  })

  it('opens a remote sign-in tab with the imported browser profile', async () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1']),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await expect(
      store
        .getState()
        .openBrowserProfileTabInActiveWorkspace('https://accounts.google.com/', 'profile-1')
    ).resolves.toBe(true)

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      environmentId: 'env-1',
      url: 'https://accounts.google.com/',
      profileId: 'profile-1'
    })
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
  })

  it('opens a local desktop sign-in tab when the remote host cannot stream browsers', async () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: settingsWithRuntime('env-1'),
      runtimeStatusByEnvironmentId: runtimeStatuses([]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await expect(
      store
        .getState()
        .openBrowserProfileTabInActiveWorkspace('https://accounts.google.com/', 'profile-1')
    ).resolves.toBe(true)

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']?.[0]).toMatchObject({
      url: 'https://accounts.google.com/',
      sessionProfileId: 'profile-1'
    })
  })

  it('rejects a paired-web sign-in tab when the remote host cannot stream browsers', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: settingsWithRuntime('env-1'),
      runtimeStatusByEnvironmentId: runtimeStatuses([]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await expect(
      store
        .getState()
        .openBrowserProfileTabInActiveWorkspace('https://accounts.google.com/', 'profile-1')
    ).resolves.toBe(false)

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
  })

  it('does not create a local fallback tab when remote browser creation throws', async () => {
    const store = createTestStore()
    createWebRuntimeSessionBrowserTabMock.mockRejectedValueOnce(new Error('remote down'))
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      runtimeStatusByEnvironmentId: runtimeStatuses(['browser.screencast.v1']),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'env-1'
          } as never
        ]
      }
    })

    await expect(store.getState().openNewBrowserTabInActiveWorkspace('group-1')).rejects.toThrow(
      'remote down'
    )

    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })
})
