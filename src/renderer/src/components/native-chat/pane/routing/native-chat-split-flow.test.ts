// @vitest-environment happy-dom
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type * as importCreation from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import type * as WorktreeRuntimeOwner from '@/lib/workspace/ownership/worktree-runtime-owner'
import type * as WorktreeOperationRoute from '@/lib/workspace/ownership/worktree-operation-route'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '@/store/slices/tabs/tabs-slice-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { loadWebRuntimeSessionTabsApplyModulesForTests } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'

let store: ReturnType<typeof createTestStore>
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
vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))
vi.mock('@/components/tab-bar/pane-actions/request-active-terminal-pane-split', () => ({
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
  await vi.importActual<typeof importCreation>(
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

function sourceChat(worktreeId: string) {
  const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    agentSessionAgent: 'codex',
    executionHostId: 'local'
  })
  return {
    source,
    target: { kind: 'workspace-tab', unifiedTabId: source.id, groupId: source.groupId } as const
  }
}

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
