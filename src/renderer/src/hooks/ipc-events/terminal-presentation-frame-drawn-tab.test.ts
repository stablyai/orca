import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'
import { makeTab } from '../../store/terminals/terminal-tab.test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { createStoreSessionMockApi } from '../../store/testing/app-store-session-api.test-fixture'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { store, main: true, callRuntimeRpc: vi.fn(async () => ({ ok: true, result: {} })) }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!mocks.store.current) {
    throw new Error('test store not created')
  }
  return mocks.store.current
}

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.main
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args),
    subscribe: () => () => {}
  }
}))
vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'

const WORKTREE = 'repo1::/repo1/main'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'

type Listener = (payload: Record<string, unknown>) => void

function setup(frameDrewTab = true, main = true) {
  mocks.main = main
  const listeners = new Map<string, Listener>()
  const replyTerminalCreate = vi.fn()
  const ui = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === 'string' && name.startsWith('on')
          ? (listener: Listener) => {
              listeners.set(name, listener)
              return () => {}
            }
          : name === 'replyTerminalCreate'
            ? replyTerminalCreate
            : vi.fn()
    }
  )
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), api: { ...createStoreSessionMockApi(), ui } })
  const store = createTestStore()
  mocks.store.current = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/main' })]
    },
    ...(frameDrewTab
      ? {
          tabsByWorktree: {
            [WORKTREE]: [makeTab({ id: TAB, worktreeId: WORKTREE, ptyId: null })]
          },
          terminalLayoutsByTabId: {
            [TAB]: {
              root: { type: 'leaf', leafId: LEAF },
              activeLeafId: LEAF,
              expandedLeafId: null
            }
          }
        }
      : {})
  })
  registerTerminalPresentationIpcBridge([])
  const reveal = (extra: Record<string, unknown> = {}) =>
    listeners.get('onCreateTerminal')?.({
      requestId: 'request-1',
      worktreeId: WORKTREE,
      ptyId: 'pty-1',
      tabId: TAB,
      leafId: LEAF,
      title: 'Build',
      presentation: 'background',
      ...extra
    })
  return { store, reveal, replyTerminalCreate }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.callRuntimeRpc.mockClear()
})

// Main’s frame may precede reveal; reuse its ID rather than adding a second terminal tab.
describe.each([false, true])('revealing an accepted host terminal (main layout = %s)', (main) => {
  it('shows the tab its frame drew, bound to main’s terminal, instead of a second one', () => {
    const { store, reveal, replyTerminalCreate } = setup(true, main)

    reveal()

    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
    expect(store.getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-1'
    })
    expect(replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-1', tabId: TAB })
    )
    expect(replyTerminalCreate.mock.calls[0]?.[0]).not.toHaveProperty('error')
  })

  it('before its frame, draws the tab under main’s ids so main finds the create already done', () => {
    const { store, reveal } = setup(false, main)

    reveal()

    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
    expect(store.getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-1'
    })
  })
  it('deduplicates reveal/reply projection without replaying startup or changing a later pane selection', () => {
    const { store, reveal } = setup(true, main)
    const otherLeaf = '22222222-2222-4222-8222-222222222222'
    seedStore(store, {
      terminalLayoutsByTabId: {
        [TAB]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: otherLeaf }
          },
          activeLeafId: otherLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [otherLeaf]: 'pty-existing' }
        }
      }
    })

    reveal({ command: 'echo already-delivered' })
    reveal({ command: 'echo already-delivered' })

    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
    expect(store.getState().terminalLayoutsByTabId[TAB]?.activeLeafId).toBe(otherLeaf)
    expect(store.getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-1',
      [otherLeaf]: 'pty-existing'
    })
    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })
})
