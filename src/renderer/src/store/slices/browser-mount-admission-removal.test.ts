/**
 * Leak regression (STA-7436): a background-opened page's start admission must end however the page
 * leaves the store. A bulk worktree purge used to drop the page records without releasing it.
 * The sweep is the same function useTerminalWindowLifecycle runs on every store change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

vi.mock('@/components/browser-pane/host-guest/webview-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  destroyPersistentWebview: vi.fn(() => Promise.resolve())
}))

// Main answers the window's layout commands; its frames draw the browser tabs.
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

createStoreCascadesMockApi()

const { isBrowserPageMountAdmitted } =
  await import('@/components/browser-pane/host-guest/browser-page-mount-admission')
const { destroyWebviewsRemovedFromStore, destroyWorktreeBrowserGuests } =
  await import('./browser-webview-cleanup')

const WT = 'repo1::/path/wt1'

let main: TabsDrawnFromMain | undefined

/** A layout-owner build draws the tabs from main's frames; every change is in once this resolves. */
async function settled(): Promise<void> {
  await main?.settle()
}

async function storeWithWorktree(): Promise<ReturnType<typeof createTestStore>> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
  main = await drawTabsFromMain(store)
  return store
}

function sweepRemovedPages(
  store: ReturnType<typeof createTestStore>,
  previous: ReadonlySet<string>
): Set<string> {
  const state = store.getState()
  return destroyWebviewsRemovedFromStore(
    previous,
    state.browserTabsByWorktree,
    state.browserPagesByWorkspace
  )
}

async function openBackgroundTabs(
  store: ReturnType<typeof createTestStore>,
  count: number
): Promise<string[]> {
  const workspaceIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    workspaceIds.push(
      store.getState().createBrowserTab(WT, `https://example.com/${index}`, { activate: false }).id
    )
  }
  await settled()
  return workspaceIds.map((id) => store.getState().browserPagesByWorkspace[id]?.[0]?.id ?? '')
}

const admittedCount = (pageIds: readonly string[]): number =>
  pageIds.filter(isBrowserPageMountAdmitted).length

describe('browser page mount admission ends when the page leaves the store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    main?.close()
    main = undefined
  })

  it('ends on a bulk worktree purge', async () => {
    const store = await storeWithWorktree()
    const pageIds = await openBackgroundTabs(store, 5)
    const before = sweepRemovedPages(store, new Set())
    expect(admittedCount(pageIds)).toBe(5)

    store.getState().purgeWorktreeTerminalState([WT])
    await settled()
    sweepRemovedPages(store, before)

    expect(admittedCount(pageIds)).toBe(0)
  })

  it('ends when the guest is evicted, though the page stays in the store', async () => {
    const store = await storeWithWorktree()
    const pageIds = await openBackgroundTabs(store, 3)
    const state = store.getState()
    expect(admittedCount(pageIds)).toBe(3)

    destroyWorktreeBrowserGuests(state.browserTabsByWorktree, state.browserPagesByWorkspace, WT)

    expect(admittedCount(pageIds)).toBe(0)
    expect(Object.values(store.getState().browserPagesByWorkspace).flat()).toHaveLength(3)
  })

  it('ends when the tab or the page is closed', async () => {
    const store = await storeWithWorktree()
    const [closedTabPage, keptTabPage] = await openBackgroundTabs(store, 2)
    const keptWorkspaceId = store.getState().browserTabsByWorktree[WT]?.[1]?.id ?? ''
    const extraPage = store.getState().createBrowserPage(keptWorkspaceId, 'https://example.com/x', {
      activate: false
    })
    await settled()
    let seen = sweepRemovedPages(store, new Set())
    const closedWorkspaceId = store.getState().browserTabsByWorktree[WT]?.[0]?.id ?? ''

    store.getState().closeBrowserTab(closedWorkspaceId)
    await settled()
    seen = sweepRemovedPages(store, seen)
    store.getState().closeBrowserPage(extraPage?.id ?? '')
    await settled()
    sweepRemovedPages(store, seen)

    expect(isBrowserPageMountAdmitted(closedTabPage)).toBe(false)
    expect(isBrowserPageMountAdmitted(extraPage?.id ?? '')).toBe(false)
    expect(isBrowserPageMountAdmitted(keptTabPage)).toBe(true)
  })
})
