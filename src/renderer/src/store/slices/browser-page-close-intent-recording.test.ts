import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

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
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

/** The paired runtime's answer to the page close; main answers the window's layout commands. */
function runtimeAnswers(answer: () => Promise<unknown> | undefined): void {
  mocks.callRuntimeRpc.mockImplementation((_target: unknown, method: string, params: unknown) =>
    method === 'layout.apply' ? layoutApplyTestTransport.call(params) : answer()
  )
}
runtimeAnswers(() => undefined)

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

/** Calls that reached the paired runtime, not main's layout. */
const runtimeCalls = () =>
  mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method !== 'layout.apply')

const WORKTREE_ID = 'repo1::/path/wt1'
const DOC_LOCATION = {
  kind: 'workspace-doc' as const,
  worktreeId: WORKTREE_ID,
  filePath: '/home/alice/wt1/report/index.html'
}

async function createStoreWithClientHostedPage(
  handleOverrides: Record<string, unknown> = {}
): Promise<{ store: ReturnType<typeof createTestStore>; pageId: string }> {
  runtimeAnswers(() => undefined)
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  // A layout-owner build draws the tab and its pages from main's frames.
  main?.close()
  main = await drawTabsFromMain(store)
  const tab = store.getState().createBrowserTab(WORKTREE_ID, 'https://remote.example/')
  await main.settle()
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

// Runtime persists client-hosted pages; undelivered plain/conversion closes need durable intents for reconnect or runtime restart resurrects them.
describe('durable close intents for unheard client-hosted page closes', () => {
  it('records an intent when the conversion-away close never reaches the runtime', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage()
    runtimeAnswers(() => Promise.reject(new Error('runtime unreachable')))

    const converted = store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    expect(converted).not.toBeNull()
    await vi.waitFor(() => expect(recordedIntents(store)).toEqual(['remote-page-1']))
  })

  it('records an intent when the plain page close never reaches the runtime', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage()
    runtimeAnswers(() => Promise.reject(new Error('runtime unreachable')))

    store.getState().closeBrowserPage(pageId)

    await vi.waitFor(() => expect(recordedIntents(store)).toEqual(['remote-page-1']))
  })

  it('records nothing when the close succeeds', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage()
    runtimeAnswers(() => Promise.resolve({}))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(runtimeCalls()).not.toHaveLength(0))
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing when the runtime has definitively forgotten the page', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage()
    runtimeAnswers(() => Promise.reject(new Error('browser_tab_not_found')))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(runtimeCalls()).not.toHaveLength(0))
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing for a server-placed page, which dies with its runtime', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage({
      placement: { kind: 'server' }
    })
    runtimeAnswers(() => Promise.reject(new Error('runtime unreachable')))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(runtimeCalls()).not.toHaveLength(0))
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })

  it('records nothing for a staged page the runtime never minted', async () => {
    const { store, pageId } = await createStoreWithClientHostedPage({ staged: true })
    // A staged page is left out of the window's save, so frames would redraw it from main's copy.
    main?.close()
    runtimeAnswers(() => Promise.reject(new Error('runtime unreachable')))

    store.getState().convertBrowserPage(pageId, {
      kind: 'workspace-doc',
      docLocation: DOC_LOCATION
    })

    await vi.waitFor(() => expect(runtimeCalls()).not.toHaveLength(0))
    await Promise.resolve()
    expect(recordedIntents(store)).toEqual([])
  })
})
