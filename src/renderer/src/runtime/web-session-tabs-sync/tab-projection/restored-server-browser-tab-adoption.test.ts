import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { buildPersistedBrowserPagesByWorkspace } from '@/lib/workspace/persistence/workspace-session-browser-tabs'
import { buildRestoredRemoteBrowserPageHandles } from '@/store/slices/browser/hosts/browser-host-state'
import { applyWebSessionTabsSnapshot } from '../snapshots/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'

const PAGE = 'page-streamed-1'
const WORKSPACE = 'local-workspace-1'
const LOCAL_TAB = 'local-tab-1'
const GROUP = 'group-1'

// A streamed tab this desktop created: local workspace/tab ids, page id shared with the server.
function relaunchedState() {
  const live: BrowserPage = {
    id: PAGE,
    workspaceId: WORKSPACE,
    worktreeId: WT,
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW,
    browserRuntimeEnvironmentId: ENV
  }
  const saved = buildPersistedBrowserPagesByWorkspace(
    { [WORKSPACE]: [live] },
    { [PAGE]: { environmentId: ENV, remotePageId: PAGE } },
    {}
  )
  return makeState({
    browserTabsByWorktree: {
      [WT]: [{ ...live, id: WORKSPACE, activePageId: PAGE, pageIds: [PAGE] }]
    },
    browserPagesByWorkspace: saved,
    remoteBrowserPageHandlesByPageId: buildRestoredRemoteBrowserPageHandles(saved),
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: LOCAL_TAB,
          entityId: WORKSPACE,
          groupId: GROUP,
          worktreeId: WT,
          contentType: 'browser',
          label: 'Example',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW
        }
      ]
    },
    groupsByWorktree: {
      [WT]: [{ id: GROUP, worktreeId: WT, activeTabId: LOCAL_TAB, tabOrder: [LOCAL_TAB] }]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WT]: GROUP }
  })
}

function serverRow(): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'browser',
    id: PAGE,
    title: 'Example',
    browserWorkspaceId: PAGE,
    browserPageId: PAGE,
    url: 'https://example.com/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true
  }
}

describe('restored server browser tab adoption', () => {
  beforeEach(() => resetWebSessionTabsSyncTestState())

  it('adopts the restored tab for its server row instead of adding a second tab', () => {
    const state = relaunchedState()
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([serverRow()], { activeTabType: 'browser', activeTabId: PAGE }),
        ENV,
        NOW + 1
      )
    }

    const browserTabs = (next.unifiedTabsByWorktree[WT] ?? []).filter(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserTabs.map((tab) => [tab.id, tab.entityId])).toEqual([[LOCAL_TAB, WORKSPACE]])
    expect(next.browserTabsByWorktree[WT]?.map((workspace) => workspace.id)).toEqual([WORKSPACE])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE]).toMatchObject({
      environmentId: ENV,
      remotePageId: PAGE
    })
  })

  it('never lets another server claim the restored tab', () => {
    const state = relaunchedState()
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(
        state,
        makeSnapshot([serverRow()], { activeTabType: 'browser', activeTabId: PAGE }),
        'web-env-other',
        NOW + 1
      )
    }

    expect(next.browserTabsByWorktree[WT]?.map((workspace) => workspace.id)).toEqual([WORKSPACE])
    expect(next.remoteBrowserPageHandlesByPageId[PAGE]).toBeUndefined()
  })
})
