import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'
import { makeTab } from '../../store/terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { createStoreSessionMockApi } from '../../store/testing/app-store-session-api.test-fixture'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { store, dispatchSplit: vi.fn() }
})

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => mocks.store.current!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      mocks.store.current!.setState(...args),
    subscribe: () => () => {}
  }
}))
vi.mock(
  '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    hasRegisteredRuntimeTerminalTab: () => true
  })
)
vi.mock('@/components/terminal-pane/layout/split/terminal-pane-split-request-routing', () => ({
  dispatchTerminalPaneSplitRequest: mocks.dispatchSplit,
  queueTerminalPaneSplitRequest: vi.fn()
}))
vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'

const WORKTREE = 'repo1::/repo1/main'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SOURCE_LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'

type Listener = (payload: Record<string, unknown>) => void

function revealBackgroundSplit(): void {
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
  const store = createTestStore()
  mocks.store.current = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/main' })]
    },
    tabsByWorktree: {
      [WORKTREE]: [makeTab({ id: TAB, worktreeId: WORKTREE, ptyId: 'pty-1' })]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: SOURCE_LEAF },
        activeLeafId: SOURCE_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SOURCE_LEAF]: 'pty-1' }
      }
    }
  })
  registerTerminalPresentationIpcBridge([])
  listeners.get('onCreateTerminal')?.({
    worktreeId: WORKTREE,
    ptyId: 'pty-2',
    tabId: TAB,
    leafId: NEW_LEAF,
    splitFromLeafId: SOURCE_LEAF,
    splitDirection: 'vertical',
    activate: false,
    presentation: 'background'
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.dispatchSplit.mockReset()
})

describe('a runtime split revealed in the window', () => {
  it('asks the pane not to take focus when the split is in the background', () => {
    revealBackgroundSplit()

    expect(mocks.dispatchSplit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ newLeafId: NEW_LEAF, activate: false })
    )
  })
})
