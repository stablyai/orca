import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLocalBrowserPageOwner } from './browser'
import type { AppState } from '../types'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks
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

  it('uses the target worktree host default profile when creating a browser tab', () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
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
      },
      defaultBrowserSessionProfileId: 'local-default',
      defaultBrowserSessionProfileIdByHostId: {
        local: 'local-default',
        'runtime:env-1': 'remote-default'
      }
    })

    const tab = store.getState().createBrowserTab('wt-remote', 'https://example.com')

    expect(tab.sessionProfileId).toBe('remote-default')
  })

  it('routes browser bridge ownership from the workspace instead of Active Server', () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'windows-2' } as AppState['settings'],
      repos: [
        {
          id: 'local-repo',
          path: '/local',
          displayName: 'Local',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'remote-repo',
          path: '/remote',
          displayName: 'Remote',
          badgeColor: '#000000',
          addedAt: 2,
          connectionId: null,
          executionHostId: 'runtime:windows-2'
        }
      ],
      worktreesByRepo: {
        'local-repo': [{ id: 'local-wt', repoId: 'local-repo' }] as never,
        'remote-repo': [{ id: 'remote-wt', repoId: 'remote-repo' }] as never
      }
    })

    expect(isLocalBrowserPageOwner(store.getState(), 'local-wt', undefined)).toBe(true)
    expect(isLocalBrowserPageOwner(store.getState(), 'remote-wt', undefined)).toBe(false)
    expect(isLocalBrowserPageOwner(store.getState(), 'local-wt', 'windows-2')).toBe(false)
    expect(isLocalBrowserPageOwner(store.getState(), 'remote-wt', null)).toBe(true)
  })

  it('stores a runtime-resolved browser partition without a renderer profile mirror', () => {
    const store = createTestStore()
    store.setState({ browserSessionProfiles: [] })

    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      sessionProfileId: 'profile-isolated',
      sessionPartition: 'persist:orca-browser-session-profile-isolated'
    })

    expect(tab.sessionProfileId).toBe('profile-isolated')
    expect(tab.sessionPartition).toBe('persist:orca-browser-session-profile-isolated')
    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]?.sessionPartition).toBe(
      'persist:orca-browser-session-profile-isolated'
    )
  })

  it('stores a runtime-resolved partition when switching browser tab profiles', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      sessionProfileId: null,
      sessionPartition: 'persist:orca-browser'
    })

    store
      .getState()
      .switchBrowserTabProfile(
        tab.id,
        'profile-isolated',
        'persist:orca-browser-session-profile-isolated'
      )

    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]).toEqual(
      expect.objectContaining({
        sessionProfileId: 'profile-isolated',
        sessionPartition: 'persist:orca-browser-session-profile-isolated'
      })
    )
  })
})
