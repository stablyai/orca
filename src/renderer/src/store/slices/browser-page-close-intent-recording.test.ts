import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree } from './store-test-helpers'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/doc-preview-grants', () => ({
  releaseDocPreviewGrant: vi.fn(),
  ensureDocPreviewGrant: vi.fn(),
  buildDocPreviewGrantRequest: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return { ...actual, callRuntimeRpc: mocks.callRuntimeRpc }
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

function createStoreWithClientHostedPage(handleOverrides: Record<string, unknown> = {}): {
  store: ReturnType<typeof createTestStore>
  pageId: string
} {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://remote.example/')
  const pageId = store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id ?? ''
  store.setState((s) => ({
    remoteBrowserPageHandlesByPageId: {
      ...s.remoteBrowserPageHandlesByPageId,
      [pageId]: {
        environmentId: 'env-1',
        remotePageId: 'remote-page-1',
        placement: { kind: 'client' },
        ...handleOverrides
      } as never
    }
  }))
  mocks.callRuntimeRpc.mockClear()
  return { store, pageId }
}

function recordedIntents(store: ReturnType<typeof createTestStore>): string[] {
  return (store.getState().clientHostedBrowserCloseIntentsByEnvironment['env-1'] ?? []).map(
    (intent) => intent.browserPageId
  )
}

// The runtime persists client-hosted pages so they survive its restarts — which turns a close it
// never heard into a resurrection. Every single-page close of such a page (plain close AND the
// address-bar conversion) must leave a durable intent behind when the runtime does not answer,
// so the reconnect replay can deliver the close late instead of the page coming back.
describe('durable close intents for unheard client-hosted page closes', () => {
  it('records an intent when the conversion-away close never reaches the runtime', async () => {
    const { store, pageId } = createStoreWithClientHostedPage()
    mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime unreachable'))

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    expect(converted).not.toBeNull()
    await vi.waitFor(() => expect(recordedIntents(store)).toEqual(['remote-page-1']))
  })

  it('records an intent when the plain page close never reaches the runtime', async () => {
    const { store, pageId } = createStoreWithClientHostedPage()
    mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime unreachable'))

    store.getState().closeBrowserPage(pageId)

    await vi.waitFor(() => expect(recordedIntents(store)).toEqual(['remote-page-1']))
  })

  it('records nothing when the close succeeds', async () => {
    const { store, pageId } = createStoreWithClientHostedPage()
    mocks.callRuntimeRpc.mockResolvedValue({})

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing when the runtime has definitively forgotten the page', async () => {
    const { store, pageId } = createStoreWithClientHostedPage()
    mocks.callRuntimeRpc.mockRejectedValue(new Error('browser_tab_not_found'))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing for a server-placed page, which dies with its runtime', async () => {
    const { store, pageId } = createStoreWithClientHostedPage({ placement: { kind: 'server' } })
    mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime unreachable'))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing for a staged page the runtime never minted', async () => {
    const { store, pageId } = createStoreWithClientHostedPage({ staged: true })
    mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime unreachable'))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })
})
