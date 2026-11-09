// @vitest-environment happy-dom
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type * as importCreation from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import type * as WorktreeRuntimeOwner from '@/lib/workspace/ownership/worktree-runtime-owner'
import type * as WorktreeOperationRoute from '@/lib/workspace/ownership/worktree-operation-route'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '@/store/slices/tabs/tabs-slice-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { loadWebRuntimeSessionTabsApplyModulesForTests } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'

let store: ReturnType<typeof createTestStore>
let actualCreation: typeof importCreation
const { createRemote, runtimeOwners, requestSplit } = vi.hoisted(() => ({
  createRemote: vi.fn(),
  runtimeOwners: new Map<string, string>(),
  requestSplit: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: createRemote
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/tab-bar/request-active-terminal-pane-split', () => ({
  requestActiveTerminalPaneSplit: requestSplit
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', async (original) => ({
  ...(await original<typeof WorktreeRuntimeOwner>()),
  runtimeEnvironmentIdOrLocalUnlessTwin: (_state: unknown, worktreeId: string) =>
    runtimeOwners.get(worktreeId) ?? null
}))
vi.mock('@/lib/workspace/ownership/worktree-operation-route', async (original) => ({
  ...(await original<typeof WorktreeOperationRoute>()),
  resolveWorktreeOperationRouteResult: (_state: unknown, worktreeId: string) => ({
    kind: 'resolved',
    route: { runtimeEnvironmentId: runtimeOwners.get(worktreeId) ?? null }
  })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
createTabsSliceMockApi()

import { runNativeChatSplitTarget } from './native-chat-layout-actions'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'

beforeAll(async () => {
  actualCreation = await vi.importActual<typeof importCreation>(
    '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
  )
  await loadWebRuntimeSessionTabsApplyModulesForTests()
})

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  runtimeOwners.clear()
  store = createTestStore()
  createRemote.mockReset().mockResolvedValue({ status: 'created' })
})

function sourceChat(worktreeId: string, agent: 'claude' | 'codex' | null = 'codex') {
  const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    agentSessionAgent: agent ?? undefined,
    executionHostId: 'local'
  })
  return {
    source,
    target: { kind: 'workspace-tab', unifiedTabId: source.id, groupId: source.groupId } as const
  }
}

it.each([
  ['right', 'claude', null],
  ['down', 'codex', 'paired-host'],
  ['right', null, null]
] as const)(
  'Split %s from agent %s opens an empty pane beside the chat (host %s)',
  (direction, agent, host) => {
    const worktreeId = folderWorkspaceKey('chat-folder')
    if (host) {
      runtimeOwners.set(worktreeId, host)
    }
    const { source, target } = sourceChat(worktreeId, agent)
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    const state = store.getState()
    const groupId = state.activeGroupIdByWorktree[worktreeId]
    expect(groupId).not.toBe(source.groupId)
    expect(state.layoutByWorktree[worktreeId]).toMatchObject({
      direction: direction === 'right' ? 'horizontal' : 'vertical',
      first: { groupId: source.groupId },
      second: { groupId }
    })
    expect(state.groupsByWorktree[worktreeId]).toContainEqual(
      expect.objectContaining({ id: groupId, tabOrder: [] })
    )
    expect(state.unifiedTabsByWorktree[worktreeId]).toEqual([source])
    expect(state.tabsByWorktree[worktreeId] ?? []).toEqual([])
    expect(createRemote).not.toHaveBeenCalled()
  }
)

it('Close on the empty pane collapses the split back to the chat', () => {
  const worktreeId = folderWorkspaceKey('chat-folder')
  const { source, target } = sourceChat(worktreeId)
  store.setState({ activeWorktreeId: worktreeId })
  runNativeChatSplitTarget(target, 'right')
  expect(store.getState().groupsByWorktree[worktreeId]).toHaveLength(2)
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
  const state = store.getState()
  expect(state.groupsByWorktree[worktreeId].map((group) => group.id)).toEqual([source.groupId])
  expect(state.activeGroupIdByWorktree[worktreeId]).toBe(source.groupId)
  expect(state.unifiedTabsByWorktree[worktreeId]).toEqual([source])
  expect(state.splitLandingGroupIds).toEqual({})
})

it('Closing the chat keeps the workspace open on its landing; Close there leaves it', () => {
  const worktreeId = folderWorkspaceKey('chat-folder')
  const { source, target } = sourceChat(worktreeId)
  store.setState({ activeWorktreeId: worktreeId })
  runNativeChatSplitTarget(target, 'right')
  const landing = store.getState().activeGroupIdByWorktree[worktreeId]
  store.getState().closeUnifiedTab(source.id)
  let state = store.getState()
  expect(state.activeWorktreeId).toBe(worktreeId)
  expect(state.groupsByWorktree[worktreeId]).toEqual([
    expect.objectContaining({ id: landing, tabOrder: [] })
  ])
  expect(state.activeGroupIdByWorktree[worktreeId]).toBe(landing)
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
  state = store.getState()
  expect(state.activeWorktreeId).toBeNull()
  expect(state.splitLandingGroupIds).toEqual({})
})

it('Close leaves an empty split that is waiting on chosen content', () => {
  const worktreeId = folderWorkspaceKey('pending-folder')
  const { source } = sourceChat(worktreeId)
  store.setState({ activeWorktreeId: worktreeId })
  const pending = store.getState().createEmptySplitGroup(worktreeId, source.groupId, 'right')
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(false)
  expect(store.getState().groupsByWorktree[worktreeId].map((group) => group.id)).toEqual([
    source.groupId,
    pending
  ])
})

it('settles real host terminal creation after later navigation', async () => {
  createRemote.mockImplementation(actualCreation.createWebRuntimeSessionTerminal)
  vi.useFakeTimers()
  try {
    const worktreeId = folderWorkspaceKey('paired-folder')
    const { source, target } = sourceChat(worktreeId)
    store.getState().setActiveWorktree(worktreeId, 'runtime:paired-host')
    runtimeOwners.set(worktreeId, 'paired-host')
    const call = vi.fn().mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'session.tabs.createTerminal') {
        return { id: 'create', ok: true, result: { tab: { id: 'host-tab' } } }
      }
      throw new Error('snapshot unavailable')
    })
    Object.assign(window.api, { runtimeEnvironments: { call } })
    void store.getState().openNewTerminalTabInActiveWorkspace(target.groupId)
    const laterWorkspace = folderWorkspaceKey('another-folder')
    store.getState().setActiveWorktree(laterWorkspace, 'local')
    await vi.advanceTimersByTimeAsync(10_500)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'paired-host',
        method: 'session.tabs.createTerminal',
        params: expect.objectContaining({
          worktree: `id:${worktreeId}`,
          targetGroupId: source.groupId
        })
      })
    )
    expect(store.getState()).toMatchObject({
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeId,
      activeWorkspaceExecutionHostId: 'runtime:paired-host'
    })
    expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([source])
    expect(store.getState().groupsByWorktree[worktreeId]).toHaveLength(1)
    expect(store.getState().tabsByWorktree[worktreeId] ?? []).toEqual([])
  } finally {
    vi.useRealTimers()
  }
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
