import { expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

// The window's half of a chat→terminal switch, through the real store: the terminal takes the
// chat's slot, and takes the selection only if the chat still held it when the replace landed.

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn<(payload: Record<string, unknown>) => void>(),
  reply: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(() => Promise.resolve())
}))
vi.mock('@/runtime/runtime-rpc-client', async (actual) => ({
  ...(await actual<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: vi.fn(() => Promise.resolve({ ok: true }))
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
const api = createTabsSliceMockApi()
Object.assign(api.ui, {
  onLaunchRecipe: () => () => {},
  onRequestTerminalTabMount: () => () => {},
  onCreateTerminal: (listener: (payload: Record<string, unknown>) => void) => {
    mocks.createTerminal.mockImplementation(listener)
    return () => {}
  },
  replyTerminalCreate: mocks.reply
})
Object.assign(window, { dispatchEvent: () => true })
const { createTestStore, makeTabGroup, makeUnifiedTab, makeTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { registerTerminalPresentationIpcBridge } = await import('./terminal-presentation-ipc-bridge')
registerTerminalPresentationIpcBridge([])

const WT = 'repo1::/tmp/wt1'
const GROUP = 'group-1'
const TERMINAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

it.each([
  ['still held it', 'chat-tab', WT, GROUP, TERMINAL],
  ['lost it to another tab', 'u-other', WT, GROUP, 'u-other'],
  // The user moved to another workspace, or another split group, while the switch ran: the group
  // still shows the terminal in the chat's place, and nothing reveals or focuses it.
  ['held it in a workspace the user left', 'chat-tab', 'repo1::/tmp/wt2', GROUP, TERMINAL],
  ['held it while the user worked in another split group', 'chat-tab', WT, 'group-2', TERMINAL]
])(
  'takes the chat’s slot, and its selection only if the chat %s',
  (_name, active, shown, activeGroup, after) => {
    seedStore(store, {
      activeWorktreeId: shown,
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/tmp/wt1' })] },
      tabsByWorktree: { [WT]: [makeTab({ id: 'other', worktreeId: WT })] },
      unifiedTabsByWorktree: {
        [WT]: [
          makeUnifiedTab({
            id: 'chat-tab',
            entityId: 'session-1',
            groupId: GROUP,
            worktreeId: WT,
            contentType: 'agent-session',
            executionHostId: 'local'
          }),
          makeUnifiedTab({
            id: 'u-other',
            entityId: 'other',
            groupId: GROUP,
            worktreeId: WT,
            contentType: 'terminal'
          })
        ]
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: GROUP,
            worktreeId: WT,
            activeTabId: active,
            tabOrder: ['chat-tab', 'u-other'],
            recentTabIds: [active]
          }),
          makeTabGroup({ id: 'group-2', worktreeId: WT, activeTabId: null, tabOrder: [] })
        ]
      },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
      activeGroupIdByWorktree: { [WT]: activeGroup },
      openFiles: [],
      browserTabsByWorktree: {}
    })
    mocks.createTerminal({
      requestId: `request-${active}`,
      worktreeId: WT,
      ptyId: 'switch-pty',
      tabId: TERMINAL,
      leafId: '11111111-1111-4111-8111-111111111111',
      activate: true,
      focus: true,
      replaces: { tabId: 'chat-tab' }
    })
    const group = store.getState().groupsByWorktree[WT]?.[0]
    expect(group?.tabOrder).toEqual([TERMINAL, 'u-other'])
    expect(group?.activeTabId).toBe(after)
    expect(store.getState().activeWorktreeId).toBe(shown)
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(activeGroup)
    expect(mocks.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabId: TERMINAL, closed: ['chat-tab'] })
    )
  }
)
