// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type * as WorktreeRuntimeOwner from '@/lib/worktree-runtime-owner'
import type * as WorktreeOperationRoute from '@/lib/worktree-operation-route'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

let store: ReturnType<typeof createTestStore>
const { createRemote, runtimeOwners, requestSplit } = vi.hoisted(() => ({
  createRemote: vi.fn(),
  runtimeOwners: new Map<string, string>(),
  requestSplit: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: createRemote
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/tab-bar/request-active-terminal-pane-split', () => ({
  requestActiveTerminalPaneSplit: requestSplit
}))
vi.mock('@/lib/worktree-runtime-owner', async (original) => ({
  ...(await original<typeof WorktreeRuntimeOwner>()),
  runtimeEnvironmentIdOrLocalUnlessTwin: (_state: unknown, worktreeId: string) =>
    runtimeOwners.get(worktreeId) ?? null
}))
vi.mock('@/lib/worktree-operation-route', async (original) => ({
  ...(await original<typeof WorktreeOperationRoute>()),
  resolveWorktreeOperationRouteResult: (_state: unknown, worktreeId: string) => ({
    kind: 'resolved',
    route: { runtimeEnvironmentId: runtimeOwners.get(worktreeId) ?? null }
  })
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
createTabsSliceMockApi()

import { runNativeChatSplitTarget } from './native-chat-layout-actions'

beforeEach(() => {
  vi.clearAllMocks()
  runtimeOwners.clear()
  store = createTestStore()
  createRemote.mockReset().mockResolvedValue({ status: 'created' })
})

function sourceChat(worktreeId: string, agent: 'claude' | 'codex' = 'codex') {
  const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    agentSessionAgent: agent,
    executionHostId: 'local'
  })
  return {
    source,
    target: { kind: 'workspace-tab', unifiedTabId: source.id, groupId: source.groupId } as const
  }
}

it.each([
  ['right', 'claude'],
  ['down', 'codex']
] as const)(
  'Split %s from %s creates a shell and preserves the original chat',
  async (direction, agent) => {
    const worktreeId = folderWorkspaceKey('local-folder')
    const { source, target } = sourceChat(worktreeId, agent)
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    await vi.waitFor(() => expect(store.getState().tabsByWorktree[worktreeId]).toHaveLength(1))
    const state = store.getState()
    const terminal = state.tabsByWorktree[worktreeId][0]
    const groupId = state.activeGroupIdByWorktree[worktreeId]
    expect(state.layoutByWorktree[worktreeId]).toMatchObject({
      direction: direction === 'right' ? 'horizontal' : 'vertical',
      first: { groupId: source.groupId },
      second: { groupId }
    })
    expect(state.unifiedTabsByWorktree[worktreeId]).toEqual([
      source,
      expect.objectContaining({ contentType: 'terminal', groupId, entityId: terminal.id })
    ])
    expect(state.pendingStartupByTabId[terminal.id]).toBeUndefined()
    expect(terminal.launchAgent).toBeUndefined()
    expect(state.activeTabTypeByWorktree[worktreeId]).toBe('terminal')
    expect(createRemote).not.toHaveBeenCalled()
  }
)

it.each(['failed', 'rejected', 'populated'] as const)(
  'settles a paired folder split safely when %s',
  async (result) => {
    const worktreeId = folderWorkspaceKey('paired-folder')
    const { source, target } = sourceChat(worktreeId)
    runtimeOwners.set(worktreeId, 'paired-host')
    let settle: (outcome: { status: 'created' | 'failed' }) => void = () => {}
    let reject: (error: Error) => void = () => {}
    createRemote.mockReturnValue(
      new Promise((resolve, fail) => {
        settle = resolve
        reject = fail
      })
    )
    expect(runNativeChatSplitTarget(target, 'right')).toBe(true)
    const groupId = store.getState().activeGroupIdByWorktree[worktreeId]
    // Changing the global selection must not redirect an already-requested split.
    store.setState({ activeWorktreeId: 'another-workspace' })
    await vi.waitFor(() =>
      expect(createRemote).toHaveBeenCalledExactlyOnceWith(
        {
          worktreeId,
          environmentId: 'paired-host',
          targetGroupId: groupId,
          activate: true
        },
        { userAct: true }
      )
    )
    if (result === 'populated') {
      store.getState().createTab(worktreeId, groupId)
    }
    if (result === 'rejected') {
      reject(new Error('disconnected'))
    } else {
      settle({ status: 'failed' })
    }
    await vi.waitFor(() => {
      expect(store.getState().groupsByWorktree[worktreeId]).toHaveLength(
        result === 'populated' ? 2 : 1
      )
      if (result === 'rejected') {
        expect(toast.error).toHaveBeenCalledOnce()
      }
    })
    expect(store.getState().unifiedTabsByWorktree[worktreeId][0]).toEqual(source)
    expect(store.getState().activeWorktreeId).toBe('another-workspace')
  }
)

it('keeps a successful paired split for its mirrored terminal', async () => {
  const worktreeId = folderWorkspaceKey('paired-folder')
  const { target } = sourceChat(worktreeId)
  runtimeOwners.set(worktreeId, 'paired-host')
  runNativeChatSplitTarget(target, 'down')
  await vi.waitFor(() => expect(createRemote).toHaveBeenCalledOnce())
  expect(store.getState().groupsByWorktree[worktreeId]).toHaveLength(2)
  expect(store.getState().tabsByWorktree[worktreeId] ?? []).toEqual([])
})

it('keeps floating chat splits local while a remote workspace is selected', async () => {
  const { target } = sourceChat(FLOATING_TERMINAL_WORKTREE_ID)
  runtimeOwners.set(FLOATING_TERMINAL_WORKTREE_ID, 'focused-remote')
  store.setState({ activeWorktreeId: 'remote-workspace' })
  runNativeChatSplitTarget(target, 'right')
  await vi.waitFor(() =>
    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
  )
  expect(createRemote).not.toHaveBeenCalled()
  expect(store.getState().activeWorktreeId).toBe('remote-workspace')
})

it('retains the existing terminal-backed chat split route', () => {
  expect(
    runNativeChatSplitTarget({ kind: 'terminal-pane', terminalTabId: 'terminal' }, 'down')
  ).toBe(true)
  expect(requestSplit).toHaveBeenCalledExactlyOnceWith({
    tabId: 'terminal',
    direction: 'horizontal'
  })
})
