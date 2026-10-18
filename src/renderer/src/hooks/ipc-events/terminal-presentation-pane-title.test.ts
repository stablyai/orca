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
  return {
    store,
    layoutOwner: { isMain: true },
    callRuntimeRpc: vi.fn(async () => ({ ok: true, result: {} }))
  }
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
    return mocks.layoutOwner.isMain
  }
}))
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

/** A CLI terminal named "Build", revealed into a tab the window holds already or not. */
function setup(windowHoldsTab: boolean) {
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
    ...(windowHoldsTab
      ? {
          tabsByWorktree: {
            [WORKTREE]: [makeTab({ id: TAB, worktreeId: WORKTREE, ptyId: 'pty-1' })]
          },
          terminalLayoutsByTabId: {
            [TAB]: {
              root: { type: 'leaf', leafId: LEAF },
              activeLeafId: LEAF,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF]: 'pty-1' }
            }
          }
        }
      : {})
  })
  registerTerminalPresentationIpcBridge([])
  listeners.get('onCreateTerminal')?.({
    requestId: 'request-1',
    worktreeId: WORKTREE,
    ptyId: 'pty-1',
    tabId: TAB,
    leafId: LEAF,
    title: 'Build',
    presentation: 'background'
  })
  return store.getState()
}

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.callRuntimeRpc.mockClear()
})

// A terminal's requested title is its tab's; main keeps pane titles for the names people give panes.
describe('a revealed terminal’s title, in a layout-owner build', () => {
  beforeEach(() => {
    mocks.layoutOwner.isMain = true
  })

  it('names a new tab and writes no pane title main does not hold', async () => {
    const state = setup(false)

    // Main names the tab first; the window shows the name on its reply.
    await vi.waitFor(() =>
      expect(testStore().getState().tabsByWorktree[WORKTREE]?.[0]?.customTitle).toBe('Build')
    )
    expect(state.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({ [LEAF]: 'pty-1' })
    expect(state.terminalLayoutsByTabId[TAB]?.titlesByLeafId).toBeUndefined()
  })

  it('writes no pane title into a tab the window already holds', () => {
    const state = setup(true)

    expect(state.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({ [LEAF]: 'pty-1' })
    expect(state.terminalLayoutsByTabId[TAB]?.titlesByLeafId).toBeUndefined()
  })
})

describe('a revealed terminal’s title, while the window owns the layout', () => {
  beforeEach(() => {
    mocks.layoutOwner.isMain = false
  })

  it.each([
    ['a new tab', false],
    ['a tab the window already holds', true]
  ])('still writes it as the pane title of %s', (_name, windowHoldsTab) => {
    const state = setup(windowHoldsTab)

    expect(state.terminalLayoutsByTabId[TAB]?.titlesByLeafId).toEqual({ [LEAF]: 'Build' })
  })
})
