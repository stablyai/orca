import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { store }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!mocks.store.current) {
    throw new Error('test store not created')
  }
  return mocks.store.current
}

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
// The shipped build: the window owns the layout.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args),
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'

const WORKTREE = 'repo1::/repo1/main'
const SETUP = {
  tabId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
  leafId: '11111111-1111-4111-8111-000000000001'
}
const AGENT = {
  tabId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002',
  leafId: '11111111-1111-4111-8111-000000000002'
}

type Listener = (payload: Record<string, unknown>) => void

function groupOrder(): string[] {
  const state = testStore().getState()
  const unified = state.unifiedTabsByWorktree[WORKTREE] ?? []
  const entityOf = (id: string): string => unified.find((tab) => tab.id === id)?.entityId ?? id
  return (state.groupsByWorktree[WORKTREE]?.[0]?.tabOrder ?? []).map(entityOf)
}

describe('a prepared agent’s first reveal in the window-owned layout', () => {
  it('lands before Setup once, and later reveals keep the user’s order', () => {
    const listeners = new Map<string, Listener>()
    const ui = new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === 'string' && name.startsWith('on')
            ? (listener: Listener) => {
                listeners.set(name, listener)
                return () => {}
              }
            : vi.fn()
      }
    )
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), api: { ...createStoreSessionMockApi(), ui } })
    mocks.store.current = createTestStore()
    seedStore(testStore(), {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/main' })]
      }
    })
    registerTerminalPresentationIpcBridge([])
    const reveal = listeners.get('onCreateTerminal')!
    reveal({
      requestId: 'setup',
      worktreeId: WORKTREE,
      ptyId: 'pty-setup',
      ...SETUP,
      title: 'Setup',
      presentation: 'background'
    })
    const agentReveal = {
      worktreeId: WORKTREE,
      ptyId: 'pty-agent',
      ...AGENT,
      launchAgent: 'claude',
      presentation: 'background',
      newTabPlacement: {}
    }

    reveal({ ...agentReveal, requestId: 'agent-first' })
    expect(groupOrder()).toEqual([AGENT.tabId, SETUP.tabId])

    // The user moves the agent; an overlapping or reattaching publication of the same launch must not undo it.
    const state = testStore().getState()
    const group = state.groupsByWorktree[WORKTREE]![0]!
    state.reorderUnifiedTabs(group.id, group.tabOrder.toReversed())
    expect(groupOrder()).toEqual([SETUP.tabId, AGENT.tabId])
    reveal({ ...agentReveal, requestId: 'agent-again' })
    expect(groupOrder()).toEqual([SETUP.tabId, AGENT.tabId])
    expect(testStore().getState().tabsByWorktree[WORKTREE]).toHaveLength(2)
  })
})
