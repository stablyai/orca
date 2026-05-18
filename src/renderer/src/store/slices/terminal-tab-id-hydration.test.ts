import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { buildHydratedTabState } from './tabs-hydration'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: apiProxy() }

import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const BAD_TAB_ID = 'host-tab::11111111-1111-4111-8111-111111111111'
const GOOD_TAB_ID = 'terminal-good'
const WORKTREE_ID = 'repo1::/wt-1'

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('terminal tab id hydration', () => {
  it('drops unified terminal tabs whose IDs cannot form pane keys', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          {
            id: BAD_TAB_ID,
            entityId: BAD_TAB_ID,
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Bad remote terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: GOOD_TAB_ID,
            entityId: GOOD_TAB_ID,
            groupId: 'g1',
            worktreeId: 'w1',
            contentType: 'terminal',
            label: 'Good terminal',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: BAD_TAB_ID,
            tabOrder: [BAD_TAB_ID, GOOD_TAB_ID]
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1.map((tab) => tab.id)).toEqual([GOOD_TAB_ID])
    expect(result.groupsByWorktree.w1[0]).toMatchObject({
      activeTabId: null,
      tabOrder: [GOOD_TAB_ID]
    })
  })

  it('drops legacy terminal tabs whose IDs cannot form pane keys', () => {
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      activeTabId: BAD_TAB_ID,
      tabsByWorktree: {
        w1: [
          {
            id: BAD_TAB_ID,
            ptyId: null,
            worktreeId: 'w1',
            title: 'bad',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 100
          },
          {
            id: GOOD_TAB_ID,
            ptyId: null,
            worktreeId: 'w1',
            title: 'good',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 101
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))

    expect(result.unifiedTabsByWorktree.w1.map((tab) => tab.id)).toEqual([GOOD_TAB_ID])
    expect(result.groupsByWorktree.w1[0]).toMatchObject({
      activeTabId: null,
      tabOrder: [GOOD_TAB_ID]
    })
  })

  it('drops runtime terminal state whose IDs cannot form pane keys', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
      }
    })

    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: BAD_TAB_ID,
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab({ id: BAD_TAB_ID, worktreeId: WORKTREE_ID, ptyId: 'bad-pty', sortOrder: 0 }),
          makeTab({ id: GOOD_TAB_ID, worktreeId: WORKTREE_ID, ptyId: 'good-pty', sortOrder: 1 })
        ]
      },
      terminalLayoutsByTabId: {
        [BAD_TAB_ID]: makeLayout(),
        [GOOD_TAB_ID]: makeLayout()
      },
      activeTabIdByWorktree: {
        [WORKTREE_ID]: BAD_TAB_ID
      },
      remoteSessionIdsByTabId: {
        [BAD_TAB_ID]: 'bad-remote',
        [GOOD_TAB_ID]: 'good-remote'
      },
      activeWorktreeIdsOnShutdown: [WORKTREE_ID]
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([GOOD_TAB_ID])
    expect(store.getState().activeTabId).toBeNull()
    expect(store.getState().activeTabIdByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(store.getState().terminalLayoutsByTabId[BAD_TAB_ID]).toBeUndefined()
    expect(store.getState().terminalLayoutsByTabId[GOOD_TAB_ID]).toBeDefined()
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
      [GOOD_TAB_ID]: 'good-remote'
    })
  })
})
