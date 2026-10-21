// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { getWorktreeIdsWithStructuredChat } from '../sidebar/visible-worktree-activity-inputs'
import { selectIsSleepingWorktree } from '../sidebar/use-worktree-sleep-state'
import { hasSleepableWorkspaceActivity } from '../sidebar/workspace-lineage-menu-actions'
import {
  agentSessionTabFixture,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
const mocks = vi.hoisted(() => ({ subscribeStatus: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
import { useAppStore } from '@/store'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
function emit(event: AgentSessionStatusEvent, index = 0): void {
  act(() => mocks.subscribeStatus.mock.calls[index][1](event))
}
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
})
it('keeps an unidentified twin visible, then follows only its named host through disconnect and wake', async () => {
  const workspaceId = 'repo::/repo/main'
  const tab = agentSessionTabFixture('legacy', workspaceId)
  const hosts = ['local', 'runtime:paired'] as const
  mocks.supportsCapability.mockResolvedValue(true)
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: vi.fn() })
  useAppStore.setState({
    activeWorktreeId: 'another-workspace',
    activeWorkspaceExecutionHostId: null,
    repos: hosts.map((executionHostId) => repoFixture({ executionHostId })),
    worktreesByRepo: {
      repo: hosts.map((hostId) => worktreeFixture(workspaceId, '/repo/main', { hostId }))
    },
    unifiedTabsByWorktree: { [workspaceId]: [tab] },
    structuredChatSleptAtByPaneKey: {},
    agentStatusByPaneKey: {},
    tabsByWorktree: {},
    browserTabsByWorktree: {}
  })
  const state = useAppStore.getState
  const awake = () =>
    getWorktreeIdsWithStructuredChat(
      state().unifiedTabsByWorktree,
      state().structuredChatSleptAtByPaneKey
    ).has(workspaceId)
  const sleeping = () => selectIsSleepingWorktree(state(), workspaceId)
  render(<StructuredAgentSessionStatusBridge />)
  expect(awake()).toBe(true)
  expect(sleeping()).toBe(false)
  expect(mocks.subscribeStatus).not.toHaveBeenCalled()
  act(() =>
    useAppStore.setState({ activeWorktreeId: workspaceId, activeWorkspaceExecutionHostId: 'local' })
  )
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  expect(awake()).toBe(false)
  expect(sleeping()).toBe(false)
  expect(hasSleepableWorkspaceActivity(workspaceId, state())).toBe(false)
  for (const livePanel of [
    { browserTabsByWorktree: { [workspaceId]: [{ id: 'browser' }] } },
    {
      tabsByWorktree: { [workspaceId]: [{ id: 'terminal' }] },
      ptyIdsByTabId: { terminal: ['pty'] }
    }
  ]) {
    expect(hasSleepableWorkspaceActivity(workspaceId, { ...state(), ...livePanel })).toBe(true)
  }
  emit({ type: 'end' })
  expect(awake()).toBe(false)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
  const session = {
    sessionId: tab.entityId,
    workspaceId,
    agent: 'codex',
    status: 'idle',
    latestPrompt: '',
    updatedAt: 1,
    sleptAt: 5
  } as const
  emit({ type: 'snapshot', sessions: [session] }, 1)
  expect(sleeping()).toBe(true)
  emit({ type: 'end' }, 1)
  cleanup()
  render(<StructuredAgentSessionStatusBridge />)
  expect(sleeping()).toBe(true)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(3))
  emit({ type: 'status', session: { ...session, sleptAt: undefined } }, 2)
  expect(awake()).toBe(true)
})
