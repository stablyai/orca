import { describe, expect, it, vi } from 'vitest'
import { buildBrowserSessionData } from '@/lib/workspace-session-browser-tabs'
import { workspaceSessionStateSchema } from '../../../../shared/workspace-session-schema'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { createBrowserMockApi } from './browser-slice-test-harness'
import {
  createTestStoreDrawnFromMain,
  onePaneGroup
} from './browser-slice-drawn-from-main.test-fixture'

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
// @ts-expect-error partial preload bridge
globalThis.window = { api: createBrowserMockApi(vi.fn()) }

describe('chromeless browser pages', () => {
  it.each(['wt-1', 'folder:folder-1'])(
    'persists the setting and reopens closed pages in %s',
    async (worktreeId) => {
      const { store, main } = await createTestStoreDrawnFromMain({
        activeWorktreeId: worktreeId,
        ...onePaneGroup(worktreeId)
      })
      const tab = store.getState().createBrowserTab(worktreeId, 'about:blank', { chromeless: true })
      await main.settle()
      const pageId = tab.activePageId!
      expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.chromeless).toBe(true)
      expect(store.getState().pendingAddressBarFocusByPageId[pageId]).toBeUndefined()

      const sibling = store.getState().createBrowserPage(tab.id, 'https://example.com')!
      await main.settle()
      store.getState().setBrowserPageChromeless(pageId, false)
      expect(
        store.getState().browserPagesByWorkspace[tab.id]?.find((p) => p.id === sibling.id)
          ?.chromeless
      ).toBeUndefined()
      store.getState().setBrowserPageChromeless(pageId, true)
      const state = store.getState()
      const saved = workspaceSessionStateSchema.parse({
        ...getDefaultWorkspaceSession(),
        ...buildBrowserSessionData(
          state.browserTabsByWorktree,
          state.browserPagesByWorkspace,
          state.activeBrowserTabIdByWorktree,
          {}
        )
      })
      expect(saved.browserPagesByWorkspace?.[tab.id]?.[0]?.chromeless).toBe(true)

      store.getState().closeBrowserPage(pageId)
      await main.settle()
      const reopened = store.getState().reopenClosedBrowserPage(tab.id)
      await main.settle()
      expect(reopened?.chromeless).toBe(true)
      expect(store.getState().pendingAddressBarFocusByPageId[reopened!.id]).toBeUndefined()
      store.getState().closeBrowserTab(tab.id)
      await main.settle()
      const reopenedTab = store.getState().reopenClosedBrowserTab(worktreeId)
      await main.settle()
      expect(
        store.getState().browserPagesByWorkspace[reopenedTab!.id]?.some((p) => p.chromeless)
      ).toBe(true)
    }
  )

  it('does not rewrite state for a missing page or an unchanged preference', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store
      .getState()
      .createBrowserTab('wt-1', 'https://example.com', { chromeless: true })
    await main.settle()
    const before = store.getState()
    store.getState().setBrowserPageChromeless('missing', true)
    store.getState().setBrowserPageChromeless(tab.activePageId!, true)
    expect(store.getState()).toBe(before)
  })
})
