import { takeKagiPrivateInitialNavigation } from '@/lib/kagi-private-initial-navigation'
import { describe, expect, it, vi } from 'vitest'

import '../../../../../shared/orca-profiles/constants'
import '../../../../../shared/workspace-layout/layout-owner-switch'

import '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice annotations', () => {
  it('authenticates a new local Kagi page once and forgets cold requests on close or replacement', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const raw = 'https://kagi.com/search?q=one&token=test-only#results'
    const safe = 'https://kagi.com/search?q=one#results'
    const tab = store.getState().createBrowserTab('wt-1', raw)
    await main.settle()
    const pageId = tab.activePageId!
    expect(store.getState().browserPagesByWorkspace[tab.id][0].url).toBe(safe)
    expect(takeKagiPrivateInitialNavigation(pageId, safe)).toBe(raw)
    expect(takeKagiPrivateInitialNavigation(pageId, safe)).toBe(safe)
    const cold = store.getState().createBrowserPage(tab.id, raw)!
    await main.settle()
    store.getState().closeBrowserPage(cold.id)
    await main.settle()
    expect(takeKagiPrivateInitialNavigation(cold.id, safe)).toBe(safe)
    const replaced = store.getState().createBrowserPage(tab.id, raw)!
    await main.settle()
    store.getState().setBrowserPageUrl(replaced.id, safe)
    expect(takeKagiPrivateInitialNavigation(replaced.id, safe)).toBe(safe)
    const closed = store.getState().createBrowserPage(tab.id, raw)!
    await main.settle()
    store.getState().closeBrowserTab(tab.id)
    await main.settle()
    expect(takeKagiPrivateInitialNavigation(closed.id, safe)).toBe(safe)
    main.close()
  })
})
