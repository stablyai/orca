import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../store-test-helpers'

const mocks = vi.hoisted(() => ({ beginClose: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.beginClose
}))

// `repoId::path` names both checkouts: this machine's and the paired server's.
const WORKTREE = 'repo-1::/work/app'

function chatTab(executionHostId?: Tab['executionHostId']): Tab {
  return {
    id: 'agent-session:chat-1',
    entityId: 'chat-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function storeWith(tab: Tab): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: owner resolution reads only the repo id.
    repos: [{ id: 'repo-1', path: '/work/app', name: 'app' }] as never,
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/work/app', hostId: 'local' }),
        makeWorktree({
          id: WORKTREE,
          repoId: 'repo-1',
          path: '/work/app',
          hostId: 'runtime:server-1'
        })
      ]
    },
    activeWorktreeId: 'another-workspace',
    unifiedTabsByWorktree: { [WORKTREE]: [tab] },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'group-1', worktreeId: WORKTREE, activeTabId: tab.id, tabOrder: [tab.id] }]
    }
  })
  return store
}

beforeEach(() => {
  mocks.beginClose.mockReset()
})

describe('closing a structured chat from outside its workspace', () => {
  it('stops it on the host stamped on its tab, not on whichever host shares its id', () => {
    const store = storeWith(chatTab('runtime:server-1'))

    store.getState().closeUnifiedTab('agent-session:chat-1')

    expect(mocks.beginClose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'environment', environmentId: 'server-1' },
        sessionId: 'chat-1'
      })
    )
  })

  it('names no host for an unstamped chat whose workspace two hosts publish', () => {
    const store = storeWith(chatTab())

    store.getState().closeUnifiedTab('agent-session:chat-1')

    expect(mocks.beginClose).not.toHaveBeenCalled()
    expect(store.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])
  })
})
