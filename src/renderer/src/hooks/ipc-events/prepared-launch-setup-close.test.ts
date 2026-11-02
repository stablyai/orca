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
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args),
    subscribe: () => () => {}
  }
}))
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
  tabId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011',
  leafId: '11111111-1111-4111-8111-000000000011'
}

type Listener = (payload: unknown) => void

/** A window whose main lists `waiting` as the Setup tabs of launches still waiting for their agent. */
function openWindow(waiting: { worktreeId: string; tabId: string }[]) {
  const listeners = new Map<string, Listener>()
  const ui = new Proxy(
    { getPreparedLaunchSetups: async () => waiting },
    {
      get: (target, name) =>
        name === 'getPreparedLaunchSetups'
          ? target.getPreparedLaunchSetups
          : typeof name === 'string' && name.startsWith('on')
            ? (listener: Listener) => {
                listeners.set(name, listener)
                return () => {}
              }
            : vi.fn()
    }
  )
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), api: { ...createStoreSessionMockApi(), ui } })
  return listeners
}

/** Loads the window's modules, as a first load or a reload does, and closes the selected tab there. */
async function loadWindowAndClose(waiting: boolean): Promise<string | null> {
  const { registerPreparedLaunchSetupSync, holdsPreparedLaunchSetup } =
    await import('@/lib/prepared-launch-reveal')
  const { dispatchWorkspaceTabCommand } = await import('@/lib/workspace-tab-commands')
  registerPreparedLaunchSetupSync([])
  // The window asks main once as it loads.
  await vi.waitFor(() => expect(holdsPreparedLaunchSetup(WORKTREE)).toBe(waiting))
  // The tab bar's close: the user closes Setup while the launch's agent has not appeared yet.
  dispatchWorkspaceTabCommand({ type: 'close' })
  await vi.waitFor(() =>
    expect(testStore().getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
  )
  return testStore().getState().activeWorktreeId
}

async function revealSetupAndClose(
  waiting: boolean,
  options: { reload?: boolean } = {}
): Promise<string | null> {
  const listeners = openWindow(waiting ? [{ worktreeId: WORKTREE, tabId: SETUP.tabId }] : [])
  // No panel holds focus: the close comes from the workspace's own tab bar.
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('document', { activeElement: null })
  mocks.store.current = createTestStore()
  seedStore(testStore(), {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/repo1/main' })]
    },
    activeWorktreeId: WORKTREE
  })
  registerTerminalPresentationIpcBridge([])
  listeners.get('onCreateTerminal')!({
    requestId: 'setup',
    worktreeId: WORKTREE,
    ptyId: 'pty-setup',
    ...SETUP,
    title: 'Setup',
    presentation: 'focused'
  })
  expect(testStore().getState().tabsByWorktree[WORKTREE]).toHaveLength(1)
  if (options.reload) {
    // A reloaded window keeps its restored tabs but none of its module memory, and sees no new reveal.
    vi.resetModules()
  }
  return loadWindowAndClose(waiting)
}

describe('closing the only Setup tab of an accepted agent launch', () => {
  it('keeps its workspace selected, on its empty state', async () => {
    expect(await revealSetupAndClose(true)).toBe(WORKTREE)
  })

  it('keeps it selected after the window reloads, from main’s list of waiting Setups', async () => {
    expect(await revealSetupAndClose(true, { reload: true })).toBe(WORKTREE)
  })

  it('still leaves a workspace emptied by closing an ordinary last tab', async () => {
    expect(await revealSetupAndClose(false)).toBeNull()
  })
})
