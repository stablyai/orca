import { beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => {
  const tabs: Record<string, Tab[]> = {}
  return {
    call: vi.fn(),
    supports: vi.fn(),
    apply: vi.fn(),
    activateTab: vi.fn(),
    focusGroup: vi.fn(),
    setActiveTabType: vi.fn(),
    state: {
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'local' as const,
      unifiedTabsByWorktree: tabs
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      activateTab: mocks.activateTab,
      focusGroup: mocks.focusGroup,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/local-structured-session-tabs-sync', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  applyStructuredSessionTabSnapshots: mocks.apply
}))

import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const TARGET = { kind: 'environment', environmentId: 'remote-2' } as const
function tab(id: string, host: 'local' | 'runtime:remote-2'): Tab {
  return {
    id,
    worktreeId: 'workspace',
    entityId: 'sender',
    executionHostId: host,
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.unifiedTabsByWorktree = { workspace: [tab('wrong-local', 'local')] }
  mocks.supports.mockResolvedValue(true)
  mocks.call.mockImplementation(async (_host, method: string) => {
    if (method === 'agentSession.reveal') {
      // The paired mirror, rather than the local snapshot apply, publishes the revealed tab.
      mocks.state.unifiedTabsByWorktree.workspace.push(tab('right-remote', 'runtime:remote-2'))
    }
    return { ok: true }
  })
})

it('keeps the known host through the default refresh/reveal/activation path without applying its snapshot as local', async () => {
  await expect(
    activateAiVaultStructuredSession(
      {
        structuredSession: { workspaceId: 'workspace', sessionId: 'sender' }
      },
      undefined,
      TARGET
    )
  ).resolves.toBe(true)
  expect(mocks.supports).toHaveBeenCalledWith(
    'remote-2',
    STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
    expect.any(Number)
  )
  expect(mocks.call.mock.calls.map(([host, method]) => [host, method])).toEqual([
    [TARGET, 'session.tabs.list'],
    [TARGET, 'agentSession.reveal'],
    [TARGET, 'session.tabs.list'],
    [TARGET, 'session.tabs.activate']
  ])
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(mocks.activateTab).toHaveBeenCalledOnce()
  expect(mocks.activateTab).toHaveBeenCalledWith('right-remote', { worktreeId: 'workspace' })
})
