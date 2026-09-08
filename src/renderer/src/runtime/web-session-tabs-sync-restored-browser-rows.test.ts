import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const WORKSPACE_ID = 'restored-workspace'
const PAGE_ID = 'restored-page'
const REMOTE_PAGE_ID = 'remote-page-1'

const CLIENT_PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageHostGeneration: 1
}

function restoredWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: WT,
    activePageId: PAGE_ID,
    pageIds: [PAGE_ID],
    url: 'https://example.com/survivor',
    title: 'Survivor',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000
  }
}

function restoredPage(): BrowserPage {
  return {
    id: PAGE_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: WT,
    url: 'https://example.com/survivor',
    title: 'Survivor',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 1_000,
    browserRuntimeEnvironmentId: ENV
  }
}

function restoredUnifiedTab(): Tab {
  return {
    id: 'restored-unified',
    entityId: WORKSPACE_ID,
    groupId: 'host-group-1',
    worktreeId: WT,
    contentType: 'browser',
    label: 'Survivor',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW - 1_000,
    isPreview: false,
    isPinned: false
  }
}

function restoredState(
  handle: Record<string, unknown> = {
    environmentId: ENV,
    remotePageId: REMOTE_PAGE_ID,
    restoredFromSession: true,
    restoredClientHosted: true
  }
): WebSessionTabsSyncState {
  return makeState({
    activeBrowserTabId: WORKSPACE_ID,
    activeBrowserTabIdByWorktree: { [WT]: WORKSPACE_ID },
    activeTabType: 'browser',
    activeTabTypeByWorktree: { [WT]: 'browser' },
    browserTabsByWorktree: { [WT]: [restoredWorkspace()] },
    browserPagesByWorkspace: { [WORKSPACE_ID]: [restoredPage()] },
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: handle as WebSessionTabsSyncState['remoteBrowserPageHandlesByPageId'][string]
    },
    unifiedTabsByWorktree: { [WT]: [restoredUnifiedTab()] },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'host-group-1',
          worktreeId: WT,
          activeTabId: 'restored-unified',
          tabOrder: ['restored-unified'],
          recentTabIds: ['restored-unified']
        }
      ]
    }
  })
}

function republishedSnapshot(
  placement: RuntimeMobileSessionBrowserTab['placement']
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'browser',
        id: 'host-browser-unified',
        title: 'Survivor',
        browserWorkspaceId: 'host-browser-workspace',
        browserPageId: REMOTE_PAGE_ID,
        url: 'https://example.com/survivor',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        ...(placement ? { placement } : {}),
        isActive: true
      }
    ],
    { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
  )
}

function worktreeRemovalFrame(): RuntimeMobileSessionTabsRemovedResult {
  return {
    worktree: WT,
    publicationEpoch: 'visibility-inventory-removal',
    snapshotVersion: 0,
    removed: true,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

/** Why the merge and not the raw patch: an untouched key and a culled key are both absent from a
 *  patch, so reading it directly makes "kept" and "erased" indistinguishable. */
function applyToState(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(
    state,
    snapshot,
    ENV,
    NOW
  ) as Partial<WebSessionTabsSyncState>
  return { ...state, ...patch }
}

describe('restored client-hosted browser rows', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  // Why: the seeded handle is what keeps the pane off browser.tabCreate, but it also makes the row
  // cull-eligible. Until the host republishes the page, absence from a snapshot proves nothing.
  it('keeps a restored row the host has not republished yet', () => {
    const next = applyToState(
      restoredState(),
      makeSnapshot([], { activeTabId: null, activeTabType: null })
    )

    expect(next.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([WORKSPACE_ID])
    expect(next.browserPagesByWorkspace[WORKSPACE_ID]?.map((page) => page.id)).toEqual([PAGE_ID])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeDefined()
  })

  it('keeps a restored row through a worktree tombstone frame', () => {
    const next = applyToState(restoredState(), worktreeRemovalFrame())

    expect(next.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([WORKSPACE_ID])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeDefined()
  })

  // Why: without the seeded handle the republished page has nothing to match, so adoption appends
  // a second workspace and the restored row is left pointing at the new page.
  it('adopts a republished page onto the restored row instead of appending a duplicate', () => {
    const next = applyToState(restoredState(), republishedSnapshot(CLIENT_PLACEMENT))

    expect(next.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([WORKSPACE_ID])
    expect(next.browserPagesByWorkspace[WORKSPACE_ID]?.map((page) => page.id)).toEqual([PAGE_ID])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toEqual({
      environmentId: ENV,
      remotePageId: REMOTE_PAGE_ID,
      placement: CLIENT_PLACEMENT
    })
  })

  // Why: a host that puts the page back on the server publishes no placement, so the handle is
  // otherwise byte-identical to the seed — and a surviving marker pins the pane to a client-hosted
  // view of a page this desktop does not host.
  it('clears the restored client-hosted marker when the host adopts the page onto the server', () => {
    const next = applyToState(restoredState(), republishedSnapshot(undefined))

    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toEqual({
      environmentId: ENV,
      remotePageId: REMOTE_PAGE_ID
    })
  })

  // Why: once the host has published the page, the restored carve-out is spent — an adopted row
  // that later goes missing is a real close and must still be culled.
  it('still culls an adopted row the host stops publishing', () => {
    const next = applyToState(
      restoredState({
        environmentId: ENV,
        remotePageId: REMOTE_PAGE_ID,
        placement: CLIENT_PLACEMENT
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null })
    )

    expect(next.browserTabsByWorktree[WT]).toBeUndefined()
    expect(next.remoteBrowserPageHandlesByPageId[PAGE_ID]).toBeUndefined()
  })
})
