import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../../shared/tab-types'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'
import {
  resetReopenAfterSleepForTest,
  settleReopenAfterSleep,
  sleepWorktreeBrowserTabs
} from '@/components/sidebar/workspace-actions/sleep/browser-tab-sleep'

const sleepStore = vi.hoisted(() => {
  const holder: { state: object } = { state: {} }
  return holder
})
vi.mock('../../../store/index', () => ({
  useAppStore: {
    getState: () => sleepStore.state,
    setState: vi.fn()
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => sleepStore.state,
    setState: vi.fn()
  }
}))
vi.mock('@/store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: () => {}
}))

function hostRunBrowserTab(id: string) {
  const workspace: BrowserWorkspace = {
    id: `ws-${id}`,
    worktreeId: WT,
    activePageId: `page-${id}`,
    pageIds: [`page-${id}`],
    url: `https://${id}.example/`,
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 10
  }
  const page: BrowserPage = {
    id: `page-${id}`,
    workspaceId: workspace.id,
    worktreeId: WT,
    url: workspace.url,
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: NOW - 10
  }
  const unified: Tab = {
    id: `unified-${id}`,
    entityId: workspace.id,
    groupId: 'group',
    worktreeId: WT,
    contentType: 'browser',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW - 10,
    isPreview: false,
    isPinned: false
  }
  return { workspace, page, unified }
}

describe('host snapshot after Sleep (LC2-P1)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetReopenAfterSleepForTest()
  })

  it("keeps slept tabs the host no longer lists (their pages died with the VM), then culls once they're answered", () => {
    const a = hostRunBrowserTab('a')
    const b = hostRunBrowserTab('b')
    const state = makeState({
      browserTabsByWorktree: { [WT]: [a.workspace, b.workspace] },
      browserPagesByWorkspace: { [a.workspace.id]: [a.page], [b.workspace.id]: [b.page] },
      remoteBrowserPageHandlesByPageId: {
        [a.page.id]: { environmentId: ENV, remotePageId: 'host-a' },
        [b.page.id]: { environmentId: ENV, remotePageId: 'host-b' }
      },
      unifiedTabsByWorktree: { [WT]: [a.unified, b.unified] },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group',
            worktreeId: WT,
            activeTabId: b.unified.id,
            tabOrder: [a.unified.id, b.unified.id],
            recentTabIds: [b.unified.id]
          }
        ]
      }
    })
    sleepStore.state = state
    sleepWorktreeBrowserTabs(WT, NOW)

    // The host's snapshot after the suspend lists no browser pages.
    const asleep = applyWebSessionTabsSnapshot(state, makeSnapshot([]), ENV, NOW)
    const keptIds = (asleep.browserTabsByWorktree ?? state.browserTabsByWorktree)[WT]?.map(
      (tab) => tab.id
    )
    expect(keptIds).toEqual([a.workspace.id, b.workspace.id])
    expect(
      (asleep.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree)[WT]?.map((tab) => tab.id)
    ).toEqual([a.unified.id, b.unified.id])

    // Once a host page answered for "a" after the wake, a snapshot without it is a real close.
    settleReopenAfterSleep(a.page.id)
    settleReopenAfterSleep(a.workspace.id)
    const later = applyWebSessionTabsSnapshot(state, makeSnapshot([]), ENV, NOW)
    expect(later.browserTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([b.workspace.id])
  })
})
