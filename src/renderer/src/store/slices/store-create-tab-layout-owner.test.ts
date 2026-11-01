import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import type { PublishedTab } from '../../../../shared/workspace-layout/workspace-layout-published'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({ ok: true, result: {} }))
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'

function storeWithWorktree() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'group-1', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    unifiedTabsByWorktree: {}
  })
  return store
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  provideLayoutFrameTerminalPanes({ holdsTerminalPane: () => false, terminalTab: () => undefined })
})

describe('createTab in a layout-owner build', () => {
  it('draws a tab main made itself with main’s creation facts and sends no create', () => {
    const mainTab: PublishedTab = {
      id: TAB,
      kind: 'terminal',
      entityId: TAB,
      executionHostId: 'local',
      createdAt: 42,
      customTitle: null,
      color: null,
      terminal: {
        root: { type: 'leaf', leafId: LEAF },
        panes: [{ leafId: LEAF, ptyId: 'pty-1' }],
        defaultTitle: 'Terminal 3',
        startupCwd: '/path/wt'
      }
    }
    provideLayoutFrameTerminalPanes({
      holdsTerminalPane: () => false,
      terminalTab: (worktreeId, tabId) =>
        worktreeId === WORKTREE && tabId === TAB ? mainTab : undefined
    })
    const store = storeWithWorktree()

    const tab = store.getState().createTab(WORKTREE, undefined, 'zsh', {
      id: TAB,
      initialLeafId: LEAF,
      initialPtyId: 'pty-1'
    })

    expect(tab).toMatchObject({
      createdAt: 42,
      title: 'Terminal 3',
      defaultTitle: 'Terminal 3',
      startupCwd: '/path/wt',
      ptyId: 'pty-1'
    })
    // Main's copy names no shell: the one the window resolved stays.
    expect(tab.shellOverride).toBe('zsh')
    expect(store.getState().unifiedTabsByWorktree[WORKTREE]?.[0]).toMatchObject({
      createdAt: 42,
      label: 'Terminal 3'
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s workspace to its mirror', () => {
    const store = createTestStore()
    const worktree = makeRuntimeOwnedWorktree({ id: WORKTREE, repoId: 'repo1' }, 'env-1')
    seedStore(
      store,
      runtimeOwnedRepoState('env-1', 'repo1', '/path', {
        worktreesByRepo: { repo1: [worktree] }
      })
    )

    store.getState().createTab(WORKTREE)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
