import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { store, callRuntimeRpc: vi.fn(async () => ({ ok: true, result: {} })) }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!mocks.store.current) {
    throw new Error('test store not created')
  }
  return mocks.store.current
}

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
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
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'

type Listener = (payload: Record<string, unknown>) => void

/** A CLI-created terminal: main wrote its tab; its layout frame drew it before the reveal or not. */
function setup(frameDrewTab = true) {
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
  const reveal = () =>
    listeners.get('onCreateTerminal')?.({
      requestId: 'request-1',
      worktreeId: WORKTREE,
      ptyId: 'pty-1',
      tabId: TAB,
      leafId: LEAF,
      title: 'Build',
      presentation: 'background'
    })
  return { store, reveal, replyTerminalCreate }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.callRuntimeRpc.mockClear()
})

// Main writes a CLI or phone terminal's tab before revealing it, so in a layout-owner build its
// frame can draw the tab first; the reveal must reuse it under main's id, never add a second.
describe('revealing a terminal main created, in a layout-owner build', () => {
  it('shows the tab its frame drew, bound to main’s terminal, instead of a second one', () => {
    const { store, reveal, replyTerminalCreate } = setup()

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
    const { store, reveal } = setup(false)

    reveal()

    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
    expect(store.getState().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-1'
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: expect.objectContaining({ type: 'createTerminalTab', tabId: TAB, leafId: LEAF })
    })
  })

  it('reuses the frame-drawn tab even when stale records leave the terminal’s owner unclear', () => {
    const { store, reveal, replyTerminalCreate } = setup()
    // Two other rows still record the same terminal: today's lookup calls that ambiguous.
    store.setState({
      tabsByWorktree: {
        [WORKTREE]: [
          ...store.getState().tabsByWorktree[WORKTREE]!,
          makeTab({ id: 'stale-1', worktreeId: WORKTREE, ptyId: 'pty-1' }),
          makeTab({ id: 'stale-2', worktreeId: WORKTREE, ptyId: 'pty-1' })
        ]
      }
    })

    reveal()

    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      TAB,
      'stale-1',
      'stale-2'
    ])
    expect(replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-1', tabId: TAB })
    )
  })
})
