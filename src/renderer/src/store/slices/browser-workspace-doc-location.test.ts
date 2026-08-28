import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { buildBrowserSessionData } from '@/lib/workspace-session-browser-tabs'
import {
  browserPageSchema,
  browserWorkspaceSchema
} from '../../../../shared/workspace-session-browser-schema'
import { createTestStore, makeWorktree } from './store-test-helpers'

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

const WORKTREE_ID = 'repo1::/path/wt1'
const DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/index.html'
}
// What a live document page shows: minted at mount, replaced on a hard reload, dead with the
// process. Nothing in the store, on disk or on the wire may ever carry it.
const LIVE_GRANT_URL = `orca-preview://${'a'.repeat(32)}/report/index.html`

function createStoreWithWorktree(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
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
  it('is created blank, with the document as its identity', () => {
    const store = createStoreWithWorktree()

    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })

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

  // The presence precondition for every blank-url assertion here: an ordinary tab created the same
  // way keeps the URL it was given, so a store that had stopped recording urls at all would fail
  // rather than pass by being uniformly blank.
  it('leaves an ordinary browser tab url alone', () => {
    const store = createStoreWithWorktree()

    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.url).toBe('https://example.com/')
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.docLocation ?? null).toBeNull()
  })

  // Browser parity: a browser tab is named by the document it shows, and so is this one. Without
  // this the blank url that is correct for a document page named every preview "New Tab".
  it('takes its name from the document, and falls back to the file', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')

    store.getState().updateBrowserPageState(pageId, { title: 'Quarterly Report' })
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('Quarterly Report')

    store.getState().updateBrowserPageState(pageId, { title: '' })
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')
  })

  // Why a title needs the same refusal the url has: Chromium reports the URL as the title when a
  // document declares none, and titles are stored, mirrored onto the tab and written to disk.
  it('refuses a grant url arriving as the document title', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().updateBrowserPageState(pageId, { title: LIVE_GRANT_URL })

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('index.html')
    expect(store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe('index.html')
    expect(JSON.stringify(persistedSession(store))).not.toContain('orca-preview://')
  })

  // The presence half for both: an ordinary page still gets the blank-url name, so a fallback that
  // had swallowed every title would fail here rather than pass by naming everything after a file.
  it('still names an ordinary blank browser tab New Tab', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, ORCA_BROWSER_BLANK_URL)
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().updateBrowserPageState(pageId, { title: '' })

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.title).toBe('New Tab')
  })

  // Why the third url door is fenced even though nothing reaches it today: creation and the title
  // update are fenced, and a door left open is one navigation report away from committing a grant
  // to the page every persisted, mirrored and published reader takes its url from.
  it('keeps its blank url when a navigation commits one onto it', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      title: 'index.html',
      browserRuntimeEnvironmentId: null
    })
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

  // The presence half for the door above: an ordinary page still takes the url it is given, so a
  // door that had stopped writing urls entirely would fail here rather than pass by writing none.
  it('still commits a navigation url onto an ordinary browser tab', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().setBrowserPageUrl(pageId, 'https://example.com/next')

    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]).toMatchObject({
      url: 'https://example.com/next',
      loading: true
    })
  })

  it('never asks for the address bar it does not have', () => {
    const store = createStoreWithWorktree()

    const docTab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const newTab = store.getState().createBrowserTab(WORKTREE_ID, ORCA_BROWSER_BLANK_URL)

    expect(store.getState().pendingAddressBarFocusByTabId[docTab.id]).toBeUndefined()
    // The blank url is exactly what marks an ordinary New Tab as wanting focus there.
    expect(store.getState().pendingAddressBarFocusByTabId[newTab.id]).toBe(true)
  })

  // Why the mirror is driven and not just read after creation: creation builds the workspace from
  // its one page, while every later change re-mirrors from whichever page is active. A mirror that
  // does not carry this field leaves the strip entry naming a document the reader has switched away
  // from — and the publish boundary reads the tab, not the page.
  it('follows the active page in and out of the document', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const docPageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    const urlPage = store.getState().createBrowserPage(tab.id, 'https://example.com/')

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

  // Why a repair path and not a switch: every other mirrored field can be equal while this one is
  // not — two documents named index.html in different folders share a title, and a document page's
  // url is blank by construction. Without this field in the comparison the strip entry keeps naming
  // the document the reader moved away from, and the publish boundary reads the entry.
  it('repairs a workspace still naming the document its page has left', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
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

  // Why closing has to say so: a grant is the only authority the preview scheme honors, and it
  // outlives the guest. A closed document that stays readable is a read authority nothing revokes
  // until the process ends.
  it('revokes the grant of the document tab that was closed, and only that one', () => {
    const store = createStoreWithWorktree()
    const docTab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const docPageId = store.getState().browserPagesByWorkspace[docTab.id]?.[0]?.id
    const urlTab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')

    store.getState().closeBrowserTab(urlTab.id)
    expect(mocks.releaseDocPreviewGrant).not.toHaveBeenCalled()

    store.getState().closeBrowserTab(docTab.id)

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith(docPageId)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledTimes(1)
  })

  it('revokes a document grant when only that page is closed', () => {
    mocks.releaseDocPreviewGrant.mockClear()
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const docPageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    store.getState().createBrowserPage(tab.id, 'https://example.com/')

    store.getState().closeBrowserPage(docPageId)

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledExactlyOnceWith(docPageId)
    expect(store.getState().browserPagesByWorkspace[tab.id]).toHaveLength(1)
  })

  it('reopens a closed document tab with its document identity', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })

    store.getState().closeBrowserTab(tab.id)
    const reopened = store.getState().reopenClosedBrowserTab(WORKTREE_ID)
    const page = reopened ? store.getState().browserPagesByWorkspace[reopened.id]?.[0] : undefined

    expect(page?.docLocation).toEqual(DOC_LOCATION)
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
    expect(reopened?.docLocation).toEqual(DOC_LOCATION)
  })

  it('reopens a closed document page with its document identity', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const documentPage = store.getState().createBrowserPage(tab.id, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    if (!documentPage) {
      throw new Error('Expected a document page')
    }

    store.getState().closeBrowserPage(documentPage.id)
    const reopened = store.getState().reopenClosedBrowserPage(tab.id)

    expect(reopened?.docLocation).toEqual(DOC_LOCATION)
    expect(reopened?.url).toBe(ORCA_BROWSER_BLANK_URL)
  })

  it('writes the document and not the grant to the session', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })

    const session = persistedSession(store)
    const written = JSON.stringify(session)

    expect(session.browserPagesByWorkspace?.[tab.id]?.[0]?.docLocation).toEqual(DOC_LOCATION)
    expect(session.browserPagesByWorkspace?.[tab.id]?.[0]?.url).toBe(ORCA_BROWSER_BLANK_URL)
    expect(written).not.toContain('orca-preview://')
  })

  // Why the schema is asserted separately: both browser schemas are plain z.object, which strips
  // what it does not name. An unlisted docLocation survives every step above and disappears on
  // load, restoring the document as a blank New Tab under a strip entry that still names it.
  it('survives the session schema in both halves', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const session = persistedSession(store)

    const parsedPage = browserPageSchema.parse(session.browserPagesByWorkspace?.[tab.id]?.[0])
    const parsedTab = browserWorkspaceSchema.parse(
      session.browserTabsByWorktree?.[WORKTREE_ID]?.[0]
    )

    expect(parsedPage.docLocation).toEqual(DOC_LOCATION)
    expect(parsedTab.docLocation).toEqual(DOC_LOCATION)
  })

  it('restores as the document it was, still blank', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const session = persistedSession(store)

    const restored = createStoreWithWorktree()
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

  // Why this shape and not just a missing field: salvage drops a malformed page row and leaves the
  // array empty, and hydration then rebuilds one page from the tab's own mirrored chrome.
  it('restores from the tab alone when its page row was salvaged away', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
      docLocation: DOC_LOCATION,
      browserRuntimeEnvironmentId: null
    })
    const session = persistedSession(store)

    const restored = createStoreWithWorktree()
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

  // Why a hand-written row and not one this build can produce: the store refuses to mint one, so
  // the only way a grant url reaches this field is a session written by another build. It names a
  // grant that died with the process that minted it, and the address bar would show it.
  it('blanks a grant url a foreign session carried in', () => {
    const restored = createStoreWithWorktree()

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

    expect(restored.getState().browserPagesByWorkspace['browser-1']?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
    expect(restored.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]?.url).toBe(
      ORCA_BROWSER_BLANK_URL
    )
  })
})
