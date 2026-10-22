import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import type { AppState } from '../types'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks,
  settingsWithRuntime
} from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'
import { makeWorktree } from './worktrees-slice-test-fixtures'

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
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

/** wt-1's one browser tab, whose page is a runtime's remote page, seeded in its pane group. */
function remoteBackedBrowserTab(): Partial<AppState> {
  return {
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'unified-browser-tab',
          entityId: 'workspace-1',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'browser',
          label: 'Example',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: 'unified-browser-tab',
          tabOrder: ['unified-browser-tab']
        }
      ]
    },
    browserTabsByWorktree: {
      'wt-1': [
        {
          id: 'workspace-1',
          worktreeId: 'wt-1',
          sessionProfileId: null,
          activePageId: 'page-1',
          pageIds: ['page-1'],
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'workspace-1': [
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    remoteBrowserPageHandlesByPageId: {
      'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
    }
  }
}

/** A layout-owner build's close is main's: the window sent it, and main's frame drew it. */
function expectMainClosed(command: 'closeBrowserPage' | 'closeTabs'): void {
  expect(layoutApplyTestTransport.sent.map((sent) => sent.type)).toEqual(
    ORCA_LAYOUT_OWNER_IS_MAIN ? [command] : []
  )
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

  it('does not notify the local browser manager when selecting tabs under runtime', () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      // The client stamps a server's rows on arrival; focus alone never names the owner.
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'runtime:env-1' })]
      },
      unifiedTabsByWorktree: {},
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'about:blank',
            title: 'New Tab',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    })

    store.getState().setActiveBrowserTab('workspace-1')

    expect(mockApi.browser.notifyActiveTabChanged).not.toHaveBeenCalled()
  })

  it('closes the mapped remote tab when closing a browser page in the active runtime', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      settings: settingsWithRuntime('env-1'),
      ...remoteBackedBrowserTab()
    })

    store.getState().closeBrowserPage('page-1')
    await main.settle()
    expectMainClosed('closeBrowserPage')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote tabs when closing a browser workspace in the active runtime', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      settings: settingsWithRuntime('env-1'),
      ...remoteBackedBrowserTab(),
      activeBrowserTabId: 'workspace-1',
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' }
    })

    store.getState().closeBrowserTab('workspace-1')
    await main.settle()
    expectMainClosed('closeTabs')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote pages in their owning environment after switching local', async () => {
    const { store, main } = await createTestStoreDrawnFromMain(remoteBackedBrowserTab())

    store.getState().closeBrowserPage('page-1')
    await main.settle()
    expectMainClosed('closeBrowserPage')
    expect(store.getState().browserPagesByWorkspace['workspace-1'] ?? []).toEqual([])

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })

  it('closes mapped remote tabs in their owning environment after switching environments', async () => {
    const { store, main } = await createTestStoreDrawnFromMain({
      settings: settingsWithRuntime('env-2'),
      ...remoteBackedBrowserTab()
    })

    store.getState().closeBrowserTab('workspace-1')
    await main.settle()
    expectMainClosed('closeTabs')
    expect(store.getState().browserTabsByWorktree['wt-1'] ?? []).toEqual([])

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })
})
