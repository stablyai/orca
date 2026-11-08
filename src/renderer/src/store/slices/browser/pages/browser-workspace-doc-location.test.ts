import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildBrowserSessionData } from '@/lib/workspace/persistence/workspace-session-browser-tabs'
import { browserPageSchema } from '../../../../../../shared/workspace-session/workspace-session-browser-schema'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted(() => ({ releaseDocPreviewGrant: vi.fn() }))
vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: mocks.releaseDocPreviewGrant,
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
// Main answers the window's layout commands and its frames draw the tabs (switch-on only).
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

const WORKTREE_ID = 'repo1::/path/wt1'
const DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/index.html'
}
// Grants exist only in live guest memory: process/mount-scoped and never stored, persisted or published.
const LIVE_GRANT_URL = `orca-preview://${'a'.repeat(32)}/report/index.html`

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

async function settled(): Promise<void> {
  await main?.settle()
}

/** A store showing one worktree, its tabs drawn from main once the switch is on. */
async function createStoreWithWorktree(): Promise<ReturnType<typeof createTestStore>> {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  main?.close()
  main = await drawTabsFromMain(store)
  return store
}

function persistedSession(
  store: ReturnType<typeof createTestStore>
): ReturnType<typeof buildBrowserSessionData> {
  const state = store.getState()
  return buildBrowserSessionData(
    state.browserTabsByWorktree,
    state.browserPagesByWorkspace,
    state.activeBrowserTabIdByWorktree,
    {}
  )
}

describe('a browser page that shows a workspace document', () => {
  // Chromium echoes untitled documents’ grant URLs as titles; fence this persisted/mirrored sink too.
  it('refuses a grant url arriving as the document title', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().updateBrowserPageState(pageId, { title: LIVE_GRANT_URL })

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe('index.html')
    expect(JSON.stringify(persistedSession(store))).not.toContain('orca-preview://')
  })

  // Fence navigation reports too: an unused URL sink could still persist/publish grant authority later.
  it('keeps its blank url when a navigation commits one onto it', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().setBrowserPageUrl(pageId, LIVE_GRANT_URL)

    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    expect(page?.title).toBe('index.html')
    // Nothing to wait for behind a blank url: an inert guest never reports the load that clears it.
    expect(page?.loading).toBe(false)
    expect(JSON.stringify(persistedSession(store))).not.toContain('orca-preview://')
  })

  // Drive later mirroring too: active page changes must update tab document identity, which publication reads.
  it('follows the active page in and out of the document', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const docPageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    const urlPage = store.getState().createBrowserPage(tab.id, 'https://example.com/')
    await settled()

    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation ?? null).toBeNull()
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.url).toBe(
      'https://example.com/'
    )

    store.getState().setActiveBrowserPage(tab.id, docPageId)

    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation).toEqual(
      DOC_LOCATION
    )
    expect(urlPage?.docLocation ?? null).toBeNull()
  })

  it('reopens a closed document tab with its document identity', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()

    store.getState().closeBrowserTab(tab.id)
    await settled()
    const reopened = store.getState().reopenClosedBrowserTab(WORKTREE_ID)
    await settled()
    const page = reopened ? store.getState().browserPagesByWorkspace[reopened.id]?.[0] : undefined

    expect(page?.docLocation).toEqual(DOC_LOCATION)
    expect(reopened?.docLocation).toEqual(DOC_LOCATION)
  })

  it('reopens a closed document page with its document identity', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    await settled()
    const documentPage = store.getState().createBrowserPage(tab.id, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    if (!documentPage) {
      throw new Error('Expected a document page')
    }

    store.getState().closeBrowserPage(documentPage.id)
    await settled()
    const reopened = store.getState().reopenClosedBrowserPage(tab.id)
    await settled()

    expect(reopened?.docLocation).toEqual(DOC_LOCATION)
  })

  it('restores as the document it was, still blank', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const session = persistedSession(store)

    const restored = await createStoreWithWorktree()
    restored.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...session
    })

    const page = restored.getState().browserPagesByWorkspace[tab.id]?.[0]
    expect(page?.docLocation).toEqual(DOC_LOCATION)
    expect(restored.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation).toEqual(
      DOC_LOCATION
    )
  })

  // Malformed pages salvage to empty arrays; hydration then rebuilds from tab chrome, so test that fallback.
  it('restores from the tab alone when its page row was salvaged away', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const session = persistedSession(store)

    const restored = await createStoreWithWorktree()
    restored.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...session,
      browserPagesByWorkspace: { [tab.id]: [] }
    })

    const page = restored.getState().browserPagesByWorkspace[tab.id]?.[0]
    expect(page?.docLocation).toEqual(DOC_LOCATION)
  })
})

// Apply disk prefix fence to provenance too; strip preview-scheme pointers without dropping ordinary history.
describe('conversion provenance at the session schema door', () => {
  const PAGE_ROW = {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: WORKTREE_ID,
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }

  it('sheds url provenance carrying the preview scheme and keeps ordinary provenance', () => {
    const tainted = browserPageSchema.parse({
      ...PAGE_ROW,
      convertedFrom: { kind: 'url', url: LIVE_GRANT_URL }
    })
    expect(tainted.convertedFrom ?? null).toBeNull()

    const kept = browserPageSchema.parse({
      ...PAGE_ROW,
      convertedFrom: {
        kind: 'url',
        url: 'https://example.com/',
        browserRuntimeEnvironmentId: 'env-1'
      }
    })
    expect(kept.convertedFrom).toEqual({
      kind: 'url',
      url: 'https://example.com/',
      browserRuntimeEnvironmentId: 'env-1'
    })
  })

  it('applies the same fence to convertedTo, Forward’s side of the crossing', () => {
    const tainted = browserPageSchema.parse({
      ...PAGE_ROW,
      convertedTo: { kind: 'url', url: LIVE_GRANT_URL }
    })
    expect(tainted.convertedTo ?? null).toBeNull()

    const kept = browserPageSchema.parse({
      ...PAGE_ROW,
      convertedTo: { kind: 'url', url: 'https://example.com/' }
    })
    expect(kept.convertedTo).toEqual({ kind: 'url', url: 'https://example.com/' })
  })
})
