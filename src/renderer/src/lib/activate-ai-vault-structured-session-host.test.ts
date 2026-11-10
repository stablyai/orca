import { beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => {
  const tabs: Record<string, Tab[]> = {}
  return {
    navigate: vi.fn(),
    moved: vi.fn(() => false),
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
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))
vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.navigate
}))
vi.mock('./workspace/activation/wsl-moved-chat-activation', () => ({
  activateWslMovedWorkspace: mocks.moved
}))
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
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/snapshot-apply', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  applyStructuredSessionTabSnapshots: mocks.apply
}))

import { openExistingStructuredSession } from './open-existing-structured-session'
import {
  activateAiVaultStructuredSession,
  openDesktopStructuredSession
} from './activate-ai-vault-structured-session'

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
  mocks.state.activeWorktreeId = 'workspace'
  mocks.moved.mockReturnValue(false)
  mocks.state.unifiedTabsByWorktree = { workspace: [tab('wrong-local', 'local')] }
  mocks.supports.mockResolvedValue(true)
  mocks.call.mockImplementation(async (_host, method: string) => {
    if (method === 'orchestration.partyLocation') {
      return { location: { kind: 'chat', sessionId: 'sender', worktreeId: 'workspace' } }
    }
    if (method === 'agentSession.reveal') {
      // The paired mirror, rather than the local snapshot apply, publishes the revealed tab.
      mocks.state.unifiedTabsByWorktree.workspace.push(tab('right-remote', 'runtime:remote-2'))
    }
    return { ok: true, sessionId: 'sender', workspaceId: 'workspace', agent: 'claude' }
  })
})

it('bounds a missing local History lookup and releases coalescing for a legitimate retry', async () => {
  vi.useFakeTimers()
  try {
    mocks.state.unifiedTabsByWorktree = {}
    mocks.call.mockImplementation(async (_host, method) =>
      method === 'orchestration.partyLocation' ? new Promise(() => {}) : { ok: true }
    )
    const session = { structuredSession: { sessionId: 'missing', workspaceId: 'workspace' } }
    const first = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    const second = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    await vi.advanceTimersByTimeAsync(5001)
    await Promise.all([first, second])
    expect(
      mocks.call.mock.calls.filter((call) => call[1] === 'orchestration.partyLocation')
    ).toHaveLength(1)
    const retry = activateAiVaultStructuredSession(session, undefined, { kind: 'local' })
    await vi.advanceTimersByTimeAsync(5001)
    await retry
    expect(
      mocks.call.mock.calls.filter((call) => call[1] === 'orchestration.partyLocation')
    ).toHaveLength(2)
  } finally {
    vi.useRealTimers()
  }
})

it('derives the implicit owner and refuses the equal-ID other-owner decoy', async () => {
  mocks.state.unifiedTabsByWorktree.workspace.unshift(tab('wrong-remote', 'runtime:remote-2'))
  const pointer = { structuredSession: { workspaceId: 'workspace', sessionId: 'sender' } }
  expect(await activateAiVaultStructuredSession(pointer)).toBe(true)
  expect(mocks.activateTab).toHaveBeenCalledExactlyOnceWith('wrong-local', {
    worktreeId: 'workspace'
  })
  expect(mocks.supports).not.toHaveBeenCalled()
  mocks.activateTab.mockClear()
  await activateAiVaultStructuredSession(pointer, undefined, TARGET)
  expect(mocks.activateTab).toHaveBeenCalledExactlyOnceWith('wrong-remote', {
    worktreeId: 'workspace'
  })
})

it.each(['initialize', 'activate'] as const)(
  'admits before synchronous %s re-entry',
  async (boundary) => {
    const pointer = { workspaceId: 'workspace', sessionId: 'sync' }
    const joined: Promise<unknown>[] = []
    const joiningInitialize = vi.fn(() => true)
    const joiningPresent = vi.fn()
    const reenter = () =>
      joined.push(
        openExistingStructuredSession(pointer, {
          target: TARGET,
          initialize: joiningInitialize,
          present: joiningPresent
        })
      )
    const parts = {
      tabs: () => [{ id: 'sync-tab', sessionId: pointer.sessionId }],
      activate: vi.fn(() => {
        if (boundary === 'activate') {
          reenter()
        }
        return true
      }),
      refresh: vi.fn(async () => undefined),
      reveal: vi.fn(async () => 'gone' as const)
    }
    const present = vi.fn()
    expect(
      await openExistingStructuredSession(pointer, {
        target: TARGET,
        deps: parts,
        present,
        initialize: () => {
          if (boundary === 'initialize') {
            reenter()
          }
          return true
        }
      })
    ).toBe('activated')
    expect(await Promise.all(joined)).toEqual(['activated'])
    expect(parts.activate).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledOnce()
    expect(joiningInitialize).not.toHaveBeenCalled()
    expect(joiningPresent).not.toHaveBeenCalled()
  }
)

it('keeps indirect continuation discovery independent from direct exact selection', async () => {
  mocks.state.unifiedTabsByWorktree.workspace.push(tab('direct', 'runtime:remote-2'))
  const successor = tab('successor-issued', 'runtime:remote-2')
  successor.entityId = 'successor'
  successor.agentSessionAgent = 'codex'
  mocks.state.unifiedTabsByWorktree.workspace.push(successor)
  const located = Promise.withResolvers<{
    location: { kind: 'chat'; sessionId: string; worktreeId: string }
  }>()
  const locate = vi.fn(() => located.promise)
  const indirect = openDesktopStructuredSession(
    { kind: 'notification', worktreeId: 'workspace', sessionId: 'sender' },
    TARGET,
    undefined,
    locate
  )
  const direct = activateAiVaultStructuredSession(
    { structuredSession: { workspaceId: 'workspace', sessionId: 'sender' } },
    undefined,
    TARGET
  )
  expect(await direct).toBe(true)
  expect(mocks.activateTab).toHaveBeenCalledExactlyOnceWith('direct', { worktreeId: 'workspace' })
  located.resolve({ location: { kind: 'chat', sessionId: 'successor', worktreeId: 'workspace' } })
  expect(await indirect).toEqual({
    kind: 'opened',
    target: { sessionId: 'successor', worktreeId: 'workspace', agent: 'codex' },
    tab: { id: 'successor-issued', sessionId: 'successor', agent: 'codex' }
  })
  expect(locate).toHaveBeenCalledOnce()
  expect(mocks.activateTab).toHaveBeenLastCalledWith('successor-issued', {
    worktreeId: 'workspace'
  })
  expect(
    mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.reveal')
  ).toHaveLength(0)
})
