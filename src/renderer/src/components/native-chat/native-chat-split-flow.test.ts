// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

let store: ReturnType<typeof createTestStore>
const launch = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launch }))
const activateWorkspace = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: activateWorkspace }))
createTabsSliceMockApi()

import { runNativeChatSplitTarget } from './native-chat-layout-actions'

it.each(['right', 'down'] as const)(
  'Split %s opens a fresh chat beside the current one',
  (direction) => {
    launch.mockReset()
    store = createTestStore()
    const worktreeId = 'folder-workspace'
    const executionHostId = 'runtime:remote-host'
    const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
      agentSessionAgent: 'codex',
      executionHostId
    })
    const { id: unifiedTabId, groupId: sourceGroupId } = source
    const target = { kind: 'workspace-tab', unifiedTabId, groupId: sourceGroupId } as const
    launch.mockReturnValue({ surface: { kind: 'local-chat', tabId: 'fresh' } })
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    const groupId = store.getState().activeGroupIdByWorktree[worktreeId]
    expect(store.getState().layoutByWorktree[worktreeId]).toMatchObject({
      direction: direction === 'right' ? 'horizontal' : 'vertical',
      first: { groupId: sourceGroupId },
      second: { groupId }
    })
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestedSurface: 'chat',
        selectedExecutionHostId: executionHostId,
        agent: 'codex',
        worktreeId,
        groupId,
        focusIntent: expect.objectContaining({ cancel: expect.any(Function) })
      })
    )
    expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([source])
    const layout = store.getState().layoutByWorktree[worktreeId]
    launch.mockReturnValue(null)
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    expect(toast.error).toHaveBeenLastCalledWith('Could not build launch command for Codex.')
    expect(store.getState().layoutByWorktree[worktreeId]).toEqual(layout)
  }
)

it('Split with terminal targets the chat workspace and drops the pane if the shell fails', async () => {
  launch.mockReset()
  store = createTestStore()
  const worktreeId = 'folder-workspace'
  const failingOpenTerminal = vi.fn(async () => {
    throw new Error('host unreachable')
  })
  store.setState({ openNewTerminalTabInActiveWorkspace: failingOpenTerminal })
  const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    agentSessionAgent: 'codex',
    executionHostId: 'runtime:remote-host'
  })
  const target = {
    kind: 'workspace-tab',
    unifiedTabId: source.id,
    groupId: source.groupId
  } as const
  expect(runNativeChatSplitTarget(target, 'right', true)).toBe(true)
  const groupId = store.getState().activeGroupIdByWorktree[worktreeId]
  expect(groupId).not.toBe(source.groupId)
  expect(activateWorkspace).toHaveBeenCalledWith(worktreeId, {
    executionHostId: 'runtime:remote-host'
  })
  expect(failingOpenTerminal).toHaveBeenCalledExactlyOnceWith(groupId)
  expect(launch).not.toHaveBeenCalled()
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getState().groupsByWorktree[worktreeId]?.map((group) => group.id)).toEqual([
    source.groupId
  ])
})

it('Split with terminal from the floating chat keeps the shell in the floating workspace', async () => {
  store = createTestStore()
  const openTerminal = vi.fn(async () => {})
  store.setState({ openNewTerminalTabInActiveWorkspace: openTerminal })
  const source = store.getState().createUnifiedTab(FLOATING_TERMINAL_WORKTREE_ID, 'agent-session', {
    agentSessionAgent: 'codex'
  })
  const target = {
    kind: 'workspace-tab',
    unifiedTabId: source.id,
    groupId: source.groupId
  } as const
  expect(runNativeChatSplitTarget(target, 'down', true)).toBe(true)
  const groupId = store.getState().activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  await Promise.resolve()
  await Promise.resolve()
  expect(openTerminal).not.toHaveBeenCalled()
  expect(
    store
      .getState()
      .unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find((tab) => tab.groupId === groupId)
      ?.contentType
  ).toBe('terminal')
})
