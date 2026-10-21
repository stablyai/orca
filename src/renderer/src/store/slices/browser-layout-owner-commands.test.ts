import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mocks = vi.hoisted(() => ({ send: vi.fn<typeof recordLayoutApply>() }))

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.send }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

function seeded(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

const sent = () => mocks.send.mock.calls.map(([, worktreeId, command]) => ({ worktreeId, command }))

function entryOf(store: ReturnType<typeof createTestStore>, browserTabId: string) {
  return store
    .getState()
    .unifiedTabsByWorktree[WT]!.find((entry) => entry.entityId === browserTabId)!
}

beforeEach(() => {
  mocks.send.mockReset()
})

describe('browser tabs in a layout-owner build', () => {
  it('records an open under the ids and place the window drew it with', () => {
    const store = seeded()
    const first = store.getState().createBrowserTab(WT, 'about:blank', { sessionProfileId: 'p1' })
    const second = store.getState().createBrowserTab(WT, 'https://example.com/')
    const firstEntry = entryOf(store, first.id)

    expect(sent()).toEqual([
      {
        worktreeId: WT,
        command: {
          type: 'openBrowserTab',
          tabId: firstEntry.id,
          browserTabId: first.id,
          pageId: first.pageIds![0],
          profileId: 'p1',
          sessionPartition: null,
          groupId: firstEntry.groupId,
          index: 0,
          createdAt: firstEntry.createdAt,
          browserCreatedAt: first.createdAt
        }
      },
      {
        worktreeId: WT,
        command: expect.objectContaining({
          type: 'openBrowserTab',
          tabId: entryOf(store, second.id).id,
          browserTabId: second.id,
          afterTabId: firstEntry.id
        })
      }
    ])
  })

  it('records a close with the window’s reason while the tab-bar entry still names it', () => {
    const store = seeded()
    const user = store.getState().createBrowserTab(WT, 'about:blank')
    const cleanup = store.getState().createBrowserTab(WT, 'about:blank')
    const userEntry = entryOf(store, user.id).id
    const cleanupEntry = entryOf(store, cleanup.id).id
    mocks.send.mockClear()

    store.getState().closeBrowserTab(user.id)
    store.getState().closeBrowserTab(cleanup.id, { reason: 'cleanup' })

    expect(sent().map(({ command }) => command)).toEqual([
      { type: 'closeTabs', tabIds: [userEntry], recordClose: 'user' },
      { type: 'closeTabs', tabIds: [cleanupEntry], recordClose: 'cleanup' }
    ])
  })

  it('records page create, convert and close, and a profile switch', () => {
    const store = seeded()
    const tab = store.getState().createBrowserTab(WT, 'about:blank')
    mocks.send.mockClear()

    // A conversion changes a page's kind: this document page becomes a web page.
    const page = store.getState().createBrowserPage(tab.id, 'about:blank', {
      docLocation: { kind: 'workspace-doc', worktreeId: WT, filePath: '/path/wt1/index.html' }
    })!
    const converted = store.getState().convertBrowserPage(page.id, {
      kind: 'web',
      url: 'https://other.example/'
    })!
    store.getState().closeBrowserPage(converted.id)
    store.getState().switchBrowserTabProfile(tab.id, 'p2', 'persist:p2')

    expect(sent().map(({ command }) => command)).toEqual([
      { type: 'openBrowserPage', browserTabId: tab.id, pageId: page.id },
      {
        type: 'replaceBrowserPage',
        browserTabId: tab.id,
        pageId: page.id,
        newPageId: converted.id
      },
      { type: 'closeBrowserPage', browserTabId: tab.id, pageId: converted.id },
      {
        type: 'setBrowserTabProfile',
        browserTabId: tab.id,
        profileId: 'p2',
        sessionPartition: 'persist:p2'
      }
    ])
    expect(sent().every(({ worktreeId }) => worktreeId === WT)).toBe(true)
  })

  it('sends nothing for a page or tab the window does not hold', () => {
    const store = seeded()

    expect(store.getState().createBrowserPage('missing', 'about:blank')).toBeNull()
    store.getState().closeBrowserPage('missing')
    store.getState().closeBrowserTab('missing')
    store.getState().switchBrowserTabProfile('missing', null)

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
