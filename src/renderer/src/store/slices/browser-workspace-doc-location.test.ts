import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { buildBrowserSessionData } from '@/lib/workspace-session-browser-tabs'
import {
  browserPageSchema,
  browserWorkspaceSchema
} from '../../../../shared/workspace-session-browser-schema'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

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
  it('is created blank, with the document as its identity', async () => {
    const store = await createStoreWithWorktree()

    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()

    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
    expect(page?.docLocation).toEqual(DOC_LOCATION)
    // The mirror is what the tab strip and every workspace-level reader see.
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation).toEqual(
      DOC_LOCATION
    )
  })

  // Require ordinary pages retain URLs so uniformly broken URL storage cannot satisfy blank-document assertions.
  it('leaves an ordinary browser tab url alone', async () => {
    const store = await createStoreWithWorktree()

    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    await settled()

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.url).toBe('https://example.com/')
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation ?? null).toBeNull()
  })

  // Document titles must use file identity; blank URL fallback otherwise names all previews New Tab.
  it('takes its name from the document, and falls back to the file', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')

    store.getState().updateBrowserPageState(pageId, { title: 'Quarterly Report' })
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('Quarterly Report')

    store.getState().updateBrowserPageState(pageId, { title: '' })
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')
  })

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

  // Require ordinary blank pages keep their title fallback so broad title suppression cannot pass.
  it('still names an ordinary blank browser tab New Tab', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, ORCA_BROWSER_BLANK_URL)
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().updateBrowserPageState(pageId, { title: '' })

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('New Tab')
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
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
    expect(page?.title).toBe('index.html')
    // Nothing to wait for behind a blank url: an inert guest never reports the load that clears it.
    expect(page?.loading).toBe(false)
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
    expect(JSON.stringify(persistedSession(store))).not.toContain('orca-preview://')
  })

  // Require ordinary navigation still writes URLs; dropping every update must not pass.
  it('still commits a navigation url onto an ordinary browser tab', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().setBrowserPageUrl(pageId, 'https://example.com/next')

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]).toMatchObject({
      url: 'https://example.com/next',
      loading: true
    })
  })

  it('never asks for the address bar it does not have', async () => {
    const store = await createStoreWithWorktree()

    const docTab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const newTab = store.getState().createBrowserTab(WORKTREE_ID, ORCA_BROWSER_BLANK_URL)
    await settled()

    expect(store.getState().pendingAddressBarFocusByTabId[docTab.id]).toBeUndefined()
    // The blank url is exactly what marks an ordinary New Tab as wanting focus there.
    expect(store.getState().pendingAddressBarFocusByTabId[newTab.id]).toBe(true)
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

  // Equal titles/blank URLs can hide document changes (two index.html files); compare docLocation or tab/publication identity stays stale.
  it('repairs a workspace still naming the document its page has left', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    const otherDocument = { ...DOC_LOCATION, filePath: '/home/alice/wt1/appendix/index.html' }
    store.setState({
      browserPagesByWorkspace: {
        ...store.getState().browserPagesByWorkspace,
        [tab.id]: [{ ...page!, docLocation: otherDocument }]
      }
    })

    store.getState().updateBrowserPageState(page!.id, { title: page!.title })

    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation).toEqual(
      otherDocument
    )
  })

  // Guest teardown alone leaves grants readable; close must revoke that preview-scheme authority.
  it('revokes the grant of the document tab that was closed, and only that one', async () => {
    const store = await createStoreWithWorktree()
    const docTab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const docPageId = store.getState().browserPagesByWorkspace[docTab.id]?.[0]?.id
    const urlTab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    await settled()

    store.getState().closeBrowserTab(urlTab.id)
    await settled()
    expect(mocks.releaseDocPreviewGrant).not.toHaveBeenCalled()

    store.getState().closeBrowserTab(docTab.id)
    await settled()

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith(docPageId)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledTimes(1)
  })

  it('revokes a document grant when only that page is closed', async () => {
    mocks.releaseDocPreviewGrant.mockClear()
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const docPageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    store.getState().createBrowserPage(tab.id, 'https://example.com/')
    await settled()

    store.getState().closeBrowserPage(docPageId)
    await settled()

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledExactlyOnceWith(docPageId)
    expect(store.getState().browserPagesByWorkspace[tab.id]).toHaveLength(1)
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
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
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
    expect(reopened?.url).toBe(ORCA_BROWSER_BLANK_URL)
  })

  it('writes the document and not the grant to the session', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()

    const session = persistedSession(store)
    const written = JSON.stringify(session)

    expect(session.browserPagesByWorkspace?.[tab.id]?.[0]?.docLocation).toEqual(DOC_LOCATION)
    expect(session.browserPagesByWorkspace?.[tab.id]?.[0]?.url).toBe(ORCA_BROWSER_BLANK_URL)
    expect(written).not.toContain('orca-preview://')
  })

  // z.object strips unknown fields: require schema docLocation or load restores a blank New Tab beneath stale document chrome.
  it('survives the session schema in both halves', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    await settled()
    const session = persistedSession(store)

    const parsedPage = browserPageSchema.parse(session.browserPagesByWorkspace?.[tab.id]?.[0])
    const parsedTab = browserWorkspaceSchema.parse(
      session.browserTabsByWorktree?.[WORKTREE_ID]?.[0]
    )

    expect(parsedPage.docLocation).toEqual(DOC_LOCATION)
    expect(parsedTab.docLocation).toEqual(DOC_LOCATION)
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
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
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
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
  })

  // Only older/handwritten sessions can contain grant URLs this build refuses; strip expired process authority before address-bar restore.
  it('blanks a grant url a foreign session carried in', async () => {
    const restored = await createStoreWithWorktree()

    restored.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'browser-1',
            worktreeId: WORKTREE_ID,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: LIVE_GRANT_URL,
            title: 'index.html',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            docLocation: DOC_LOCATION
          }
        ]
      },
      browserPagesByWorkspace: {
        'browser-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-1',
            worktreeId: WORKTREE_ID,
            url: LIVE_GRANT_URL,
            title: 'index.html',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            docLocation: DOC_LOCATION
          }
        ]
      }
    })
    await settled()

    expect(restored.getState().browserPagesByWorkspace['browser-1']?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
    expect(restored.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
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
