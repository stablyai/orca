import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../store-test-helpers'
import { drawTabsFromMain, type TabsDrawnFromMain } from '../tabs-drawn-from-main.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

const mocks = vi.hoisted(() => ({ beginClose: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.beginClose
}))
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

let main: TabsDrawnFromMain | undefined
beforeEach(() => {
  mocks.beginClose.mockReset()
})
afterEach(() => {
  main?.close()
  main = undefined
})

describe('closing a structured chat from outside its workspace', () => {
  it('stops it on the host stamped on its tab, not on whichever host shares its id', () => {
    const store = storeWith(chatTab('runtime:server-1'))

    const layoutOwner = store.getState()
    store.getState().closeUnifiedTab('agent-session:chat-1')

    expect(mocks.beginClose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'environment', environmentId: 'server-1' },
        sessionId: 'chat-1',
        layoutOwner
      })
    )
  })

  // Switch on, main's layout holds only chats this machine's host placed, so the stamp is a fact.
  it('an unstamped chat whose workspace two hosts publish: no host off, main’s host on', async () => {
    const store = storeWith(chatTab())
    main = await drawTabsFromMain(store)

    store.getState().closeUnifiedTab('agent-session:chat-1')
    await main.settle()

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(mocks.beginClose).toHaveBeenCalledWith(
        expect.objectContaining({ target: { kind: 'local' }, sessionId: 'chat-1' })
      )
      expect(layoutApplyTestTransport.sentOfType('closeTabs')).toEqual([
        expect.objectContaining({ workspace: WORKTREE, tabIds: ['agent-session:chat-1'] })
      ])
    } else {
      expect(mocks.beginClose).not.toHaveBeenCalled()
    }
    expect(store.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])
  })
})
