// Layout-owner browser commands propose IDs to main and draw from frames; content-tabs-from-main-frames.test.ts covers answer boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

let store: ReturnType<typeof createTestStore>
let main: TabsDrawnFromMain

beforeEach(async () => {
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  main = await drawTabsFromMain(store)
})

afterEach(() => {
  main.close()
})

const sent = () => [...layoutApplyTestTransport.sent]

function entryOf(browserTabId: string) {
  return store
    .getState()
    .unifiedTabsByWorktree[WT]!.find((entry) => entry.entityId === browserTabId)!
}

describe('browser tabs in a layout-owner build', () => {
  it('sends an open under the ids it proposes, which main’s frame then draws', async () => {
    const first = store.getState().createBrowserTab(WT, 'about:blank', { sessionProfileId: 'p1' })
    const second = store.getState().createBrowserTab(WT, 'https://example.com/')
    const [firstOpen, secondOpen] = layoutApplyTestTransport.sentOfType('openBrowserTab')
    await main.settle()

    const firstEntry = entryOf(first.id)
    expect(firstOpen).toEqual({
      type: 'openBrowserTab',
      workspace: WT,
      tabId: firstEntry.id,
      browserTabId: first.id,
      pageId: store.getState().browserPagesByWorkspace[first.id]![0]!.id,
      profileId: 'p1',
      sessionPartition: null,
      groupId: firstEntry.groupId
    })
    expect(secondOpen).toMatchObject({ tabId: entryOf(second.id).id, browserTabId: second.id })
    expect(store.getState().groupsByWorktree[WT]![0]!.tabOrder).toEqual([
      firstEntry.id,
      entryOf(second.id).id
    ])
  })

  it('sends page create, convert and close, and a profile switch', async () => {
    const tab = store.getState().createBrowserTab(WT, 'about:blank')
    await main.settle()
    const before = sent().length

    // A conversion changes a page's kind: this document page becomes a web page.
    const page = store.getState().createBrowserPage(tab.id, 'about:blank', {
      docLocation: { kind: 'workspace-doc', worktreeId: WT, filePath: '/path/wt1/index.html' }
    })!
    await main.settle()
    const converted = store.getState().convertBrowserPage(page.id, {
      kind: 'web',
      url: 'https://other.example/'
    })!
    await main.settle()
    store.getState().closeBrowserPage(converted.id)
    await main.settle()
    store.getState().switchBrowserTabProfile(tab.id, 'p2', 'persist:p2')
    await main.settle()

    expect(sent().slice(before)).toEqual([
      { type: 'openBrowserPage', workspace: WT, browserTabId: tab.id, pageId: page.id },
      {
        type: 'replaceBrowserPage',
        workspace: WT,
        browserTabId: tab.id,
        pageId: page.id,
        newPageId: converted.id
      },
      { type: 'closeBrowserPage', workspace: WT, browserTabId: tab.id, pageId: converted.id },
      {
        type: 'setBrowserTabProfile',
        workspace: WT,
        browserTabId: tab.id,
        profileId: 'p2',
        sessionPartition: 'persist:p2'
      }
    ])
    expect(store.getState().browserPagesByWorkspace[tab.id]).toHaveLength(1)
  })
})
