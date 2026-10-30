import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import {
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph/sync-key'
import type { AppState } from '../store/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

function makeBrowserWorkspace(
  title = 'Example'
): NonNullable<AppState['browserTabsByWorktree'][string]>[number] {
  return {
    id: 'browser-1',
    worktreeId: 'wt-1',
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com',
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('browser mobile session sync', () => {
  it.each([{ sessionProfileId: 'isolated-login' }, { sessionPartition: 'persist:changed-login' }])(
    'invalidates profile-only changes (%o)',
    (profileChange) => {
      const workspace = { ...makeBrowserWorkspace(), sessionProfileId: null }
      const base = makeState({ browserTabsByWorktree: { 'wt-1': [workspace] } })
      const initialKey = getRuntimeMobileSessionSyncKey(base)
      const initialSnapshot = buildMobileSessionTabSnapshots(base)[0]
      const changed = {
        ...base,
        browserTabsByWorktree: { 'wt-1': [{ ...workspace, ...profileChange }] }
      }

      expect(
        runtimeMobileSessionSyncKeysEqual(
          initialKey,
          getRuntimeMobileSessionSyncKey(changed, base, initialKey)
        )
      ).toBe(false)
      const updatedSnapshot = buildMobileSessionTabSnapshots(changed)[0]
      if (profileChange.sessionProfileId) {
        expect(updatedSnapshot).not.toBe(initialSnapshot)
      } else {
        expect(updatedSnapshot).toBe(initialSnapshot)
      }
      expect(updatedSnapshot?.tabs[0]).toMatchObject({
        browserProfileId: profileChange.sessionProfileId ?? 'default'
      })
      expect(buildMobileSessionTabSnapshots(changed)[0]).toBe(updatedSnapshot)
    }
  )

  it('changes when browser tab page state changes', () => {
    const base = makeState({
      browserTabsByWorktree: {
        'wt-1': [makeBrowserWorkspace()]
      }
    })
    const changed = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        browserTabsByWorktree: {
          'wt-1': [makeBrowserWorkspace('Changed')]
        }
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(getRuntimeMobileSessionSyncKey(base), changed)).toBe(
      false
    )
  })

  it('withdraws local profile authority when the active page becomes a remote mirror', () => {
    const workspace = { ...makeBrowserWorkspace(), sessionProfileId: 'local-login' }
    const page = {
      ...workspace,
      id: 'page-1',
      workspaceId: workspace.id,
      browserRuntimeEnvironmentId: null
    }
    const base = makeState({
      browserTabsByWorktree: { 'wt-1': [workspace] },
      browserPagesByWorkspace: { [workspace.id]: [page] }
    })
    const initialKey = getRuntimeMobileSessionSyncKey(base)
    expect(buildMobileSessionTabSnapshots(base)[0]?.tabs[0]).toMatchObject({
      browserProfileId: 'local-login'
    })
    const changed = {
      ...base,
      browserPagesByWorkspace: {
        [workspace.id]: [{ ...page, browserRuntimeEnvironmentId: 'remote-host' }]
      }
    }

    expect(
      runtimeMobileSessionSyncKeysEqual(
        initialKey,
        getRuntimeMobileSessionSyncKey(changed, base, initialKey)
      )
    ).toBe(false)
    const row = buildMobileSessionTabSnapshots(changed)[0]?.tabs[0]
    expect(row?.type === 'browser' && row.browserProfileId).toBeUndefined()
  })

  it('publishes browser tabs with active page metadata', () => {
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          { id: 'group-1', activeTabId: 'unified-browser-1', tabOrder: ['unified-browser-1'] }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-browser-1',
            groupId: 'group-1',
            contentType: 'browser',
            entityId: 'browser-1',
            title: 'Browser'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      browserTabsByWorktree: { 'wt-1': [makeBrowserWorkspace()] },
      browserPagesByWorkspace: {
        'browser-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.com/path',
            title: 'Example Page',
            loading: false,
            faviconUrl: null,
            canGoBack: true,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserPagesByWorkspace'],
      browserCertificateFailuresByPageId: {
        'page-1': {
          challengeId: 'challenge-1',
          browserPageId: 'page-1',
          errorCode: -202,
          error: 'ERR_CERT_AUTHORITY_INVALID',
          origin: 'https://localhost:3443',
          displayHost: 'localhost:3443',
          canProceed: true,
          observedAt: 123
        }
      }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'browser',
        id: 'unified-browser-1',
        browserWorkspaceId: 'browser-1',
        browserPageId: 'page-1',
        title: 'Example Page',
        url: 'https://example.com/path',
        canGoBack: true,
        certificateFailure: {
          challengeId: 'challenge-1',
          browserPageId: 'page-1'
        },
        isActive: true
      }
    ])
  })

  it('does not resurrect a stale workspace failure after the active page clears it', () => {
    const staleError = {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://localhost:3443/'
    }
    const workspace = { ...makeBrowserWorkspace(), loadError: staleError }
    const activePage = {
      ...workspace,
      id: 'page-1',
      workspaceId: workspace.id,
      loadError: null
    }
    const state = makeState({
      activeBrowserTabIdByWorktree: { 'wt-1': workspace.id },
      browserTabsByWorktree: { 'wt-1': [workspace] },
      browserPagesByWorkspace: { [workspace.id]: [activePage] }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).toMatchObject({
      type: 'browser',
      loadError: null
    })
  })

  it('publishes fallback browser tabs by workspace id when no unified tab exists', () => {
    const state = makeState({
      activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
      browserTabsByWorktree: { 'wt-1': [makeBrowserWorkspace()] }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'browser',
        id: 'browser-1',
        browserWorkspaceId: 'browser-1',
        title: 'Example',
        isActive: true
      }
    ])
  })
})
