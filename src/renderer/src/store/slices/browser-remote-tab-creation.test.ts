import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  createBrowserMockApi,
  resetBrowserRuntimeMocks,
  runtimeStatuses,
  settingsWithRuntime
} from './browser-slice-test-harness'
import {
  createTestStoreDrawnFromMain,
  onePaneGroup
} from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/store/slices/browser/paired-browser-tab-creator', () => ({
  getRegisteredPairedBrowserTabCreator: () => null,
  loadPairedBrowserTabCreator: async () => createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

/** A server-owned workspace's desktop tab: the window draws it, as main never holds that layout. */
function expectDrawnHere(state: AppState): void {
  expect(layoutApplyTestTransport.sent).toEqual([])
  expect(state.createUnifiedTab).toHaveBeenCalled()
}

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

  it('rejects direct client-local materialization in the web client', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const { store } = await createTestStoreDrawnFromMain()

    expect(() => store.getState().createBrowserTab('wt-1', 'about:blank')).toThrow(
      'must be created by a capable paired runtime'
    )
    expect(store.getState().browserTabsByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })

  it('rejects direct remote materialization without the provider capability', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const { store } = await createTestStoreDrawnFromMain({
      runtimeStatusByEnvironmentId: runtimeStatuses([])
    })

    expect(() =>
      store.getState().createBrowserTab('wt-1', 'about:blank', {
        browserRuntimeEnvironmentId: 'env-1'
      })
    ).toThrow('paired runtime does not support browser streaming')
    expect(store.getState().browserTabsByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })

  it('creates new browser tabs through the owning runtime for desktop remote worktrees', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      // group-1 is wt-remote's, where the new-tab click lands.
      ...onePaneGroup('wt-remote'),
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
      // Client group is authoritative desktop placement; without it local reconciliation chooses first group.
      clientTargetGroupId: 'group-1'
    })
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])
  })

  it('uses the desktop client browser when a remote npm host cannot stream', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    const tab = store.getState().browserTabsByWorktree['wt-remote']?.[0]
    const page = tab ? store.getState().browserPagesByWorkspace[tab.id]?.[0] : undefined
    expect(page?.browserRuntimeEnvironmentId).toBeNull()
    expectDrawnHere(store.getState())
  })

  it('does not create a local fallback tab when remote browser creation fails', async () => {
    // Failed remote creation must not fall back local and split workspace ownership (#5321).
    createWebRuntimeSessionBrowserTabMock.mockResolvedValueOnce(false)
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )
  })

  it('opens a remote sign-in tab with the imported browser profile', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])
  })

  it('opens a local desktop sign-in tab when the remote host cannot stream browsers', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']?.[0]).toMatchObject({
      url: 'https://accounts.google.com/',
      sessionProfileId: 'profile-1'
    })
    expectDrawnHere(store.getState())
  })

  it('rejects a paired-web sign-in tab when the remote host cannot stream browsers', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])
  })

  it('does not create a local fallback tab when remote browser creation throws', async () => {
    createWebRuntimeSessionBrowserTabMock.mockRejectedValueOnce(new Error('remote down'))
    const { store, main } = await createTestStoreDrawnFromMain({
      ...onePaneGroup('wt-remote'),
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
    await main.settle()
    expect(layoutApplyTestTransport.sent).toEqual([])

    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
  })
})
