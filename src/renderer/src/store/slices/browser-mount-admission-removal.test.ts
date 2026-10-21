/**
 * Leak regression (STA-7436): a background-opened page's start admission must end however the page
 * leaves the store. A bulk worktree purge used to drop the page records without releasing it.
 * The sweep is the same function useTerminalWindowLifecycle runs on every store change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

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

createStoreCascadesMockApi()

const { isBrowserPageMountAdmitted } =
  await import('@/components/browser-pane/host-guest/browser-page-mount-admission')
const { destroyWebviewsRemovedFromStore, destroyWorktreeBrowserGuests } =
  await import('./browser-webview-cleanup')

const WT = 'repo1::/path/wt1'

function storeWithWorktree(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal'
  })
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

function openBackgroundTabs(store: ReturnType<typeof createTestStore>, count: number): string[] {
  const pageIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const workspace = store
      .getState()
      .createBrowserTab(WT, `https://example.com/${index}`, { activate: false })
    pageIds.push(store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.id ?? '')
  }
  return pageIds
}

const admittedCount = (pageIds: readonly string[]): number =>
  pageIds.filter(isBrowserPageMountAdmitted).length

describe('browser page mount admission ends when the page leaves the store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ends on a bulk worktree purge', () => {
    const store = storeWithWorktree()
    const pageIds = openBackgroundTabs(store, 5)
    const before = sweepRemovedPages(store, new Set())
    expect(admittedCount(pageIds)).toBe(5)

    store.getState().purgeWorktreeTerminalState([WT])
    sweepRemovedPages(store, before)

    expect(admittedCount(pageIds)).toBe(0)
  })

  it('ends when the guest is evicted, though the page stays in the store', () => {
    const store = storeWithWorktree()
    const pageIds = openBackgroundTabs(store, 3)
    const state = store.getState()
    expect(admittedCount(pageIds)).toBe(3)

    destroyWorktreeBrowserGuests(state.browserTabsByWorktree, state.browserPagesByWorkspace, WT)

    expect(admittedCount(pageIds)).toBe(0)
    expect(Object.values(store.getState().browserPagesByWorkspace).flat()).toHaveLength(3)
  })

  it('ends when the tab or the page is closed', () => {
    const store = storeWithWorktree()
    const [closedTabPage, keptTabPage] = openBackgroundTabs(store, 2)
    const keptWorkspaceId = store.getState().browserTabsByWorktree[WT]?.[1]?.id ?? ''
    const extraPage = store.getState().createBrowserPage(keptWorkspaceId, 'https://example.com/x', {
      activate: false
    })
    let seen = sweepRemovedPages(store, new Set())
    const closedWorkspaceId = store.getState().browserTabsByWorktree[WT]?.[0]?.id ?? ''

    store.getState().closeBrowserTab(closedWorkspaceId)
    seen = sweepRemovedPages(store, seen)
    store.getState().closeBrowserPage(extraPage?.id ?? '')
    sweepRemovedPages(store, seen)

    expect(isBrowserPageMountAdmitted(closedTabPage)).toBe(false)
    expect(isBrowserPageMountAdmitted(extraPage?.id ?? '')).toBe(false)
    expect(isBrowserPageMountAdmitted(keptTabPage)).toBe(true)
  })
})
