import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import '@/store/testing/app-store-test-fixture'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  type BrowserLinkTestStore
} from '../navigation/browser-link-open.test-fixture'
import { openUrlInTabBesideBrowserPage } from './browser-page-tab-opening'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.getState() } }))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore

beforeEach(() => {
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
})

describe('openUrlInTabBesideBrowserPage', () => {
  it('keeps a link from a page pinned to this desktop on this desktop', () => {
    // An SSH workspace's pages are pinned with null; omitted, the server-owned workspace infers a streamed page.
    const source = store.getState().createBrowserTab(WORKSPACE, 'https://example.com/', {
      browserRuntimeEnvironmentId: null,
      activate: false
    })

    const openedPageId = openUrlInTabBesideBrowserPage({
      sourcePageId: source.activePageId!,
      worktreeId: WORKSPACE,
      url: 'https://example.com/popup',
      activate: false
    })

    const opened = Object.values(store.getState().browserPagesByWorkspace)
      .flat()
      .find((page) => page.id === openedPageId)
    expect(opened?.url).toBe('https://example.com/popup')
    expect(opened?.browserRuntimeEnvironmentId).toBe(null)
  })
})
