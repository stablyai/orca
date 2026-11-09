import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

import { browserPageSchema } from '../../../../../../shared/workspace-session/workspace-session-browser-schema'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted(() => ({ releaseDocPreviewGrant: vi.fn(), callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: mocks.releaseDocPreviewGrant,
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
// Main answers the window's layout commands (switch-on); every other call reaches the mock.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcCallModule>()
  const { runtimeRpcClientWithLayoutApply } =
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  return runtimeRpcClientWithLayoutApply({
    ...actual,
    callRuntimeRpc: mocks.callRuntimeRpc.mockResolvedValue({})
  })
})
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
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
  main = await drawTabsFromMain(store)
  return store
}

async function createDocTab(store: ReturnType<typeof createTestStore>): Promise<{
  tabId: string
  pageId: string
}> {
  const tab = store.getState().createBrowserTab(WORKTREE_ID, LIVE_GRANT_URL, {
    docLocation: DOC_LOCATION,
    title: 'index.html',
    browserRuntimeEnvironmentId: null
  })
  await settled()
  const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
  return { tabId: tab.id, pageId }
}

describe('convertBrowserPage doc→web', () => {
  it('replaces the page under a fresh id in the same workspace row', async () => {
    const store = await createStoreWithWorktree()
    const { tabId, pageId } = await createDocTab(store)

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'web',
      url: 'https://example.com/'
    })
    await settled()

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
})

describe('convertBrowserPage doc→doc retarget', () => {
  it('replaces the page and its grant for a different document', async () => {
    const store = await createStoreWithWorktree()
    const { tabId, pageId } = await createDocTab(store)
    mocks.releaseDocPreviewGrant.mockClear()

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: OTHER_DOC_LOCATION
    })
    await settled()

    expect(converted?.id).not.toBe(pageId)
    expect(mocks.releaseDocPreviewGrant).toHaveBeenCalledWith(pageId)
    const page = store.getState().browserPagesByWorkspace[tabId]?.[0]
    expect(page?.docLocation).toEqual(OTHER_DOC_LOCATION)
    expect(page?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
  })
})

describe('convertBrowserPage history legs', () => {
  it('the return leg swaps convertedFrom for convertedTo, so Forward can re-cross', async () => {
    const store = await createStoreWithWorktree()
    const { tabId, pageId } = await createDocTab(store)

    const webPage = store.getState().convertBrowserPage(pageId, {
      kind: 'web',
      url: 'https://example.com/'
    })
    await settled()
    expect(webPage?.convertedFrom).toEqual({ kind: 'workspace-doc', docLocation: DOC_LOCATION })
    expect(webPage?.convertedTo ?? null).toBeNull()

    const returned = store
      .getState()
      .convertBrowserPage(
        webPage?.id ?? '',
        { kind: 'workspace-doc', docLocation: DOC_LOCATION },
        { leg: 'history-return' }
      )
    await settled()

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
})

describe('convertBrowserPage placement and activation', () => {
  it('converts a background page without stealing the active page', async () => {
    const store = await createStoreWithWorktree()
    const { tabId, pageId: docPageId } = await createDocTab(store)
    const webPage = store.getState().createBrowserPage(tabId, 'https://active.example/', {
      activate: true
    })
    await settled()

    const converted = store.getState().convertBrowserPage(docPageId, {
      kind: 'web',
      url: 'https://converted.example/'
    })
    await settled()

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

  it('clears the old page id from every per-page side table', async () => {
    const store = await createStoreWithWorktree()
    const { pageId } = await createDocTab(store)
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
    await settled()

    expect(store.getState().pendingAddressBarFocusByPageId[pageId]).toBeUndefined()
    expect(store.getState().pendingAddressBarFocusByTabId[pageId]).toBeUndefined()
    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
  })

  // Both provenance directions retain owner or Back silently moves remote browsing local (ssh-execution-boundary).
  it('carries runtime ownership through provenance and honors it on the return leg', async () => {
    const store = await createStoreWithWorktree()
    const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://remote.example/', {
      browserRuntimeEnvironmentId: 'env-1'
    })
    await settled()
    const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''

    const docPage = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })
    await settled()
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
    await settled()
    expect(returned?.browserRuntimeEnvironmentId).toBe('env-1')
  })
})
