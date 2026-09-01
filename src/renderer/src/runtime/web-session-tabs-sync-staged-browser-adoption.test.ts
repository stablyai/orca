import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
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

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const GROUP_ID = 'client-group-1'

type BrowserRow = {
  workspaceId: string
  pageId: string
  unifiedTabId: string
  remotePageId: string
  staged: boolean
}

function makeWorkspace(row: BrowserRow, sortOrder: number): BrowserWorkspace {
  return {
    id: row.workspaceId,
    worktreeId: WT,
    activePageId: row.pageId,
    pageIds: [row.pageId],
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW + sortOrder
  }
}

function makePage(row: BrowserRow, sortOrder: number): BrowserPage {
  return {
    id: row.pageId,
    workspaceId: row.workspaceId,
    worktreeId: WT,
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW + sortOrder,
    browserRuntimeEnvironmentId: ENV,
    viewportPresetId: null
  }
}

function makeUnifiedTab(row: BrowserRow, sortOrder: number): Tab {
  return {
    id: row.unifiedTabId,
    entityId: row.workspaceId,
    groupId: GROUP_ID,
    worktreeId: WT,
    contentType: 'browser',
    label: 'Example',
    customLabel: null,
    color: null,
    sortOrder: NOW + sortOrder,
    createdAt: NOW + sortOrder,
    isPreview: false,
    isPinned: false
  }
}

/** A worktree whose only tabs are the given browser rows, in the given strip order. */
function makeBrowserState(rows: BrowserRow[], activeUnifiedTabId: string): WebSessionTabsSyncState {
  return makeState({
    activeGroupIdByWorktree: { [WT]: GROUP_ID },
    activeTabType: 'browser',
    activeTabTypeByWorktree: { [WT]: 'browser' },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP_ID,
          worktreeId: WT,
          activeTabId: activeUnifiedTabId,
          tabOrder: rows.map((row) => row.unifiedTabId)
        }
      ]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP_ID } },
    browserTabsByWorktree: { [WT]: rows.map(makeWorkspace) },
    browserPagesByWorkspace: Object.fromEntries(
      rows.map((row, index) => [row.workspaceId, [makePage(row, index)]])
    ),
    remoteBrowserPageHandlesByPageId: Object.fromEntries(
      rows.map((row) => [
        row.pageId,
        {
          environmentId: ENV,
          remotePageId: row.remotePageId,
          ...(row.staged ? { staged: true } : {})
        }
      ])
    ),
    unifiedTabsByWorktree: { [WT]: rows.map(makeUnifiedTab) }
  })
}

/** A host browser tab whose ids deliberately differ from the client's staged ids. */
function hostBrowserTab(remotePageId: string): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'browser',
    id: `host-tab-${remotePageId}`,
    title: 'Example',
    browserWorkspaceId: `host-workspace-${remotePageId}`,
    browserPageId: remotePageId,
    url: 'https://example.com/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

const MIRRORED: BrowserRow = {
  workspaceId: 'mirrored-workspace',
  pageId: 'mirrored-page',
  unifiedTabId: 'mirrored-unified-tab',
  remotePageId: 'remote-page-a',
  staged: false
}

const STAGED: BrowserRow = {
  workspaceId: 'staged-workspace',
  pageId: 'staged-page',
  unifiedTabId: 'staged-unified-tab',
  remotePageId: 'staged-page',
  staged: true
}

function applyPatch(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return {
    ...state,
    ...(applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW) as Partial<WebSessionTabsSyncState>)
  }
}

/** Which browser tabs exist. The strip's order lives in the group's tabOrder, not in this array. */
function browserTabIds(state: WebSessionTabsSyncState): string[] {
  return (state.unifiedTabsByWorktree[WT] ?? [])
    .filter((tab) => tab.contentType === 'browser')
    .map((tab) => tab.id)
    .sort()
}

/** The order the tab strip renders. */
function stripOrder(state: WebSessionTabsSyncState): string[] {
  return state.groupsByWorktree[WT]?.[0]?.tabOrder ?? []
}

describe('staged browser tab adoption', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('adopts a staged browser tab in place instead of appending the host tab', () => {
    const state = makeBrowserState([MIRRORED, STAGED], STAGED.unifiedTabId)
    // Reversed on purpose: host order must not reorder tabs this client already placed.
    const next = applyPatch(
      state,
      makeSnapshot([hostBrowserTab(STAGED.remotePageId), hostBrowserTab(MIRRORED.remotePageId)])
    )

    // The host's own workspace/tab ids never surface: the staged rows are reused, so the tab
    // is renamed in place rather than dropped and re-added at the end of the strip.
    expect(next.browserTabsByWorktree[WT]?.map((workspace) => workspace.id).sort()).toEqual(
      [MIRRORED.workspaceId, STAGED.workspaceId].sort()
    )
    expect(browserTabIds(next)).toEqual([MIRRORED.unifiedTabId, STAGED.unifiedTabId].sort())
    expect(stripOrder(next)).toEqual([MIRRORED.unifiedTabId, STAGED.unifiedTabId])
    expect(next.groupsByWorktree[WT]?.[0]?.activeTabId).toBe(STAGED.unifiedTabId)
    // Adoption is what clears the optimism; a handle left staged would freeze the pane and
    // keep the create's materialization gate from ever passing.
    expect(next.remoteBrowserPageHandlesByPageId[STAGED.pageId]).toEqual({
      environmentId: ENV,
      remotePageId: STAGED.remotePageId
    })
  })

  it('keeps a staged tab the snapshot has not published yet', () => {
    const state = makeBrowserState([MIRRORED, STAGED], STAGED.unifiedTabId)
    const next = applyPatch(state, makeSnapshot([hostBrowserTab(MIRRORED.remotePageId)]))

    expect(browserTabIds(next)).toEqual([MIRRORED.unifiedTabId, STAGED.unifiedTabId].sort())
    expect(stripOrder(next)).toEqual([MIRRORED.unifiedTabId, STAGED.unifiedTabId])
    expect(next.remoteBrowserPageHandlesByPageId[STAGED.pageId]?.staged).toBe(true)
  })

  it('still culls a mirrored workspace the snapshot dropped', () => {
    const state = makeBrowserState([MIRRORED, STAGED], STAGED.unifiedTabId)
    const next = applyPatch(state, makeSnapshot([hostBrowserTab(STAGED.remotePageId)]))

    expect(browserTabIds(next)).toEqual([STAGED.unifiedTabId])
  })

  it('keeps three rapid staged tabs in click order under a reordered snapshot', () => {
    const rows: BrowserRow[] = [1, 2, 3].map((index) => ({
      workspaceId: `staged-workspace-${index}`,
      pageId: `staged-page-${index}`,
      unifiedTabId: `staged-unified-tab-${index}`,
      remotePageId: `staged-page-${index}`,
      staged: true
    }))
    const state = makeBrowserState(rows, rows[2].unifiedTabId)
    const next = applyPatch(
      state,
      makeSnapshot(rows.toReversed().map((row) => hostBrowserTab(row.remotePageId)))
    )

    expect(browserTabIds(next)).toEqual(rows.map((row) => row.unifiedTabId).sort())
    expect(stripOrder(next)).toEqual(rows.map((row) => row.unifiedTabId))
    expect(next.groupsByWorktree[WT]?.[0]?.activeTabId).toBe(rows[2].unifiedTabId)
    for (const row of rows) {
      expect(next.remoteBrowserPageHandlesByPageId[row.pageId]?.staged).toBeUndefined()
    }
  })
})
