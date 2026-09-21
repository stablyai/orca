import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { browserPageSchema } from '../../../../shared/workspace-session-browser-schema'
import { createTestStore, makeWorktree } from './store-test-helpers'

const mocks = vi.hoisted(() => ({ releaseDocPreviewGrant: vi.fn(), callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: mocks.releaseDocPreviewGrant,
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return { ...actual, callRuntimeRpc: mocks.callRuntimeRpc.mockResolvedValue({}) }
})
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
const OTHER_DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/details.html'
}
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

function createDocTab(store: ReturnType<typeof createTestStore>): {
  tabId: string
  pageId: string
} {
  const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
    docLocation: DOC_LOCATION,
    title: 'index.html',
    browserRuntimeEnvironmentId: null
  })
  const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
  return { tabId: tab.id, pageId }
}

describe('convertBrowserPage doc→web', () => {
  it('replaces the page under a fresh id in the same workspace row', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId } = createDocTab(store)

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'web',
      url: 'https://example.com/'
    })

    expect(converted).not.toBeNull()
    // Fresh id: the old id must never resurface in the other registry half.
    expect(converted?.id).not.toBe(pageId)
    const pages = store.getState().browserPagesByWorkspace[tabId] ?? []
    expect(pages.map((page) => page.id)).toEqual([converted?.id])
    expect(pages[0]?.url).toBe('https://example.com/')
    expect(pages[0]?.docLocation ?? null).toBeNull()
    // Ownership stays client-local: an inferred runtime would render a streamed pane with no handle.
    expect(pages[0]?.browserRuntimeEnvironmentId).toBeNull()
    // The workspace row survives: same tab id, mirror flipped in the same commit.
    const workspace = store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]
    expect(workspace?.id).toBe(tabId)
    expect(workspace?.url).toBe('https://example.com/')
    expect(workspace?.docLocation ?? null).toBeNull()
    expect(workspace?.activePageId).toBe(converted?.id)
  })

  it('releases the old grant exactly once, after the store stops naming the document', () => {
    const store = createStoreWithWorktree()
    const { pageId } = createDocTab(store)
    mocks.releaseDocPreviewGrant.mockClear()

    store.getState().convertBrowserPage(pageId, { kind: 'web', url: 'https://example.com/' })

    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledTimes(1)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith(pageId)
  })

  it('records one level of provenance so Back can return to the document', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId } = createDocTab(store)

    store.getState().convertBrowserPage(pageId, { kind: 'web', url: 'https://example.com/' })

    const page = store.getState().browserPagesByWorkspace[tabId]?.[0]
    expect(page?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
    // Provenance survives the session schema (z.object strips what it does not name).
    const parsed = browserPageSchema.parse(page)
    expect(parsed.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
  })

  it('refuses to convert a web page to web — that is navigation, not conversion', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    const converted = store
      .getState()
      .convertBrowserPage(pageId, { kind: 'web', url: 'https://other.example/' })

    expect(converted).toBeNull()
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id).toBe(pageId)
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.url).toBe('https://example.com/')
  })
})

describe('convertBrowserPage web→doc', () => {
  it('replaces the page with a client-local document page and mirrors it', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    mocks.releaseDocPreviewGrant.mockClear()

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    expect(converted).not.toBeNull()
    expect(converted?.id).not.toBe(pageId)
    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    expect(page?.docLocation).toEqual(DOC_LOCATION)
    expect(page?.url).toBe(ORCA_BROWSER_BLANK_URL)
    // Client-local by construction: the grant is minted on this desktop.
    expect(page?.browserRuntimeEnvironmentId).toBeNull()
    expect(page?.convertedFrom).toEqual({ kind: 'url', url: 'https://example.com/' })
    const workspace = store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]
    expect(workspace?.docLocation).toEqual(DOC_LOCATION)
    expect(workspace?.url).toBe(ORCA_BROWSER_BLANK_URL)
    // A URL page owns no grant; nothing to release on this direction.
    expect(mocks.releaseDocPreviewGrant).not.toHaveBeenCalled()
  })

  it('never lets a grant url into the converted page, even handed one directly', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://example.com/')
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    const written = JSON.stringify([page, store.getState().browserTabsByWorktree[WORKTREE_ID]])
    expect(written).not.toContain('orca-preview://')
  })
})

describe('convertBrowserPage doc→doc retarget', () => {
  it('replaces the page and its grant for a different document', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId } = createDocTab(store)
    mocks.releaseDocPreviewGrant.mockClear()

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: OTHER_DOC_LOCATION
    })

    expect(converted?.id).not.toBe(pageId)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith(pageId)
    const page = store.getState().browserPagesByWorkspace[tabId]?.[0]
    expect(page?.docLocation).toEqual(OTHER_DOC_LOCATION)
    expect(page?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
  })

  it('is a no-op for the same document', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId } = createDocTab(store)
    mocks.releaseDocPreviewGrant.mockClear()

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    expect(converted).toBeNull()
    expect(store.getState().browserPagesByWorkspace[tabId]?.[0]?.id).toBe(pageId)
    expect(mocks.releaseDocPreviewGrant).not.toHaveBeenCalled()
  })
})

describe('convertBrowserPage history legs', () => {
  it('the return leg swaps convertedFrom for convertedTo, so Forward can re-cross', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId } = createDocTab(store)

    const webPage = store.getState().convertBrowserPage(pageId, {
      kind: 'web',
      url: 'https://example.com/'
    })
    expect(webPage?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
    expect(webPage?.convertedTo ?? null).toBeNull()

    const returned = store
      .getState()
      .convertBrowserPage(
        webPage?.id ?? '',
        { kind: 'workspace-doc', docLocation: DOC_LOCATION },
        { leg: 'history-return' }
      )

    expect(returned?.docLocation).toEqual(DOC_LOCATION)
    expect(returned?.convertedFrom ?? null).toBeNull()
    // Ownership rides the forward pointer too — explicit null keeps the page client-local.
    const expectedForward = {
      kind: 'url',
      url: 'https://example.com/',
      browserRuntimeEnvironmentId: null
    }
    expect(returned?.convertedTo).toEqual(expectedForward)
    // Forward's target survives the session schema (z.object strips what it does not name).
    const parsed = browserPageSchema.parse(store.getState().browserPagesByWorkspace[tabId]?.[0])
    expect(parsed.convertedTo).toEqual(expectedForward)
  })

  it('the advance leg re-records convertedFrom and consumes convertedTo — a two-entry ping-pong', () => {
    const store = createStoreWithWorktree()
    const { pageId } = createDocTab(store)
    const webPage = store
      .getState()
      .convertBrowserPage(pageId, { kind: 'web', url: 'https://example.com/' })
    const docPage = store
      .getState()
      .convertBrowserPage(
        webPage?.id ?? '',
        { kind: 'workspace-doc', docLocation: DOC_LOCATION },
        { leg: 'history-return' }
      )

    const advanced = store
      .getState()
      .convertBrowserPage(
        docPage?.id ?? '',
        { kind: 'web', url: 'https://example.com/' },
        { leg: 'history-advance' }
      )

    expect(advanced?.url).toBe('https://example.com/')
    expect(advanced?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
    expect(advanced?.convertedTo ?? null).toBeNull()
  })
})

describe('convertBrowserPage placement and activation', () => {
  it('converts a background page without stealing the active page', () => {
    const store = createStoreWithWorktree()
    const { tabId, pageId: docPageId } = createDocTab(store)
    const webPage = store.getState().createBrowserPage(tabId, 'https://active.example/', {
      activate: true
    })

    const converted = store.getState().convertBrowserPage(docPageId, {
      kind: 'web',
      url: 'https://converted.example/'
    })

    const pages = store.getState().browserPagesByWorkspace[tabId] ?? []
    // Replacement holds the old page's position.
    expect(pages.map((page) => page.url)).toEqual([
      'https://converted.example/',
      'https://active.example/'
    ])
    const workspace = store.getState().browserTabsByWorktree[WORKTREE_ID]?.[0]
    expect(workspace?.activePageId).toBe(webPage?.id)
    // The mirror still shows the active page, not the converted one.
    expect(workspace?.url).toBe('https://active.example/')
    expect(converted?.id).not.toBe(docPageId)
  })

  it('clears the old page id from every per-page side table', () => {
    const store = createStoreWithWorktree()
    const { pageId } = createDocTab(store)
    // Every table SEEDED, so a deletion that stops running fails instead of passing vacuously.
    store.setState((s) => ({
      pendingAddressBarFocusByPageId: { ...s.pendingAddressBarFocusByPageId, [pageId]: true },
      pendingAddressBarFocusByTabId: { ...s.pendingAddressBarFocusByTabId, [pageId]: true },
      browserAnnotationsByPageId: {
        ...s.browserAnnotationsByPageId,
        [pageId]: [{ id: 'annotation-1' }] as never
      },
      browserCertificateFailuresByPageId: {
        ...s.browserCertificateFailuresByPageId,
        [pageId]: { challengeId: 'challenge-1' } as never
      }
    }))

    store.getState().convertBrowserPage(pageId, { kind: 'web', url: 'https://example.com/' })

    expect(store.getState().pendingAddressBarFocusByPageId[pageId]).toBeUndefined()
    expect(store.getState().pendingAddressBarFocusByTabId[pageId]).toBeUndefined()
    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
  })

  // The leg the remote pane's address bar reaches: converting a runtime-owned page must close the
  // host's page and drop the handle, or a ghost page stays open on the remote host.
  it('closes the remote page and drops its handle when a runtime-owned page converts', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://remote.example/')
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
    store.setState((s) => ({
      remoteBrowserPageHandlesByPageId: {
        ...s.remoteBrowserPageHandlesByPageId,
        [pageId]: { environmentId: 'env-1', remotePageId: 'remote-page-1' } as never
      }
    }))
    mocks.callRuntimeRpc.mockClear()

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    expect(converted).not.toBeNull()
    expect(store.getState().remoteBrowserPageHandlesByPageId[pageId]).toBeUndefined()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.tabClose',
      expect.objectContaining({ page: 'remote-page-1' }),
      expect.anything()
    )
  })

  // Ownership rides provenance both ways, or Back silently moves a remote tab's browsing onto
  // this desktop (the ssh-execution-boundary concern).
  it('carries runtime ownership through provenance and honors it on the return leg', () => {
    const store = createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://remote.example/', {
      browserRuntimeEnvironmentId: 'env-1'
    })
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    const docPage = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })
    expect(docPage?.convertedFrom).toEqual({
      kind: 'url',
      url: 'https://remote.example/',
      browserRuntimeEnvironmentId: 'env-1'
    })

    const returned = store.getState().convertBrowserPage(
      docPage?.id ?? '',
      {
        kind: 'web',
        url: 'https://remote.example/',
        browserRuntimeEnvironmentId: 'env-1'
      },
      { leg: 'history-return' }
    )
    expect(returned?.browserRuntimeEnvironmentId).toBe('env-1')
  })

  it('returns a worktree-inferred remote page as inferred, never as client-local', () => {
    const store = createStoreWithWorktree()
    const { pageId } = createDocTab(store)
    // The return leg says "inferred" by passing the property explicitly undefined.
    const returned = store
      .getState()
      .convertBrowserPage(
        pageId,
        { kind: 'web', url: 'https://remote.example/', browserRuntimeEnvironmentId: undefined },
        { leg: 'history-return' }
      )
    expect(returned).not.toBeNull()
    expect('browserRuntimeEnvironmentId' in (returned ?? {})).toBe(false)
  })

  it('returns null for an unknown page and changes nothing', () => {
    const store = createStoreWithWorktree()
    createDocTab(store)
    const before = store.getState().browserPagesByWorkspace

    const converted = store
      .getState()
      .convertBrowserPage('missing-page', { kind: 'web', url: 'https://example.com/' })

    expect(converted).toBeNull()
    expect(store.getState().browserPagesByWorkspace).toBe(before)
  })
})
