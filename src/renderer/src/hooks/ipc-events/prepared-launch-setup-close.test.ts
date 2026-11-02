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
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'

const WORKTREE = 'repo1::/repo1/main'
const SETUP = {
  tabId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011',
  leafId: '11111111-1111-4111-8111-000000000011'
}

type Listener = (payload: Record<string, unknown>) => void

async function revealSetupAndClose(preparedLaunchSetup: boolean): Promise<string | null> {
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
    presentation: 'focused',
    ...(preparedLaunchSetup ? { preparedLaunchSetup: true } : {})
  })
  expect(testStore().getState().tabsByWorktree[WORKTREE]).toHaveLength(1)
  // The tab bar's close: the user closes Setup while the launch's agent has not appeared yet.
  dispatchWorkspaceTabCommand({ type: 'close' })
  await vi.waitFor(() =>
    expect(testStore().getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
  )
  return testStore().getState().activeWorktreeId
}

describe('closing the only Setup tab of an accepted agent launch', () => {
  it('keeps its workspace selected, on its empty state', async () => {
    expect(await revealSetupAndClose(true)).toBe(WORKTREE)
  })

  it('still leaves a workspace emptied by closing an ordinary last tab', async () => {
    expect(await revealSetupAndClose(false)).toBeNull()
  })
})
