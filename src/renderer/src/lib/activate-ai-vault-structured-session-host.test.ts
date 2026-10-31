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
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: mocks.navigate }))
vi.mock('./wsl-moved-chat-activation', () => ({ activateWslMovedWorkspace: mocks.moved }))
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
vi.mock('@/runtime/local-structured-session-tabs-sync/snapshot-apply', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  applyStructuredSessionTabSnapshots: mocks.apply
}))

import { openExistingStructuredSession } from './open-existing-structured-session'
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
  mocks.state.activeWorktreeId = 'workspace'
  mocks.moved.mockReturnValue(false)
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

it('keeps implicit activation unfiltered while explicit automation refuses an equal-ID other owner', async () => {
  const pointer = { structuredSession: { workspaceId: 'workspace', sessionId: 'sender' } }
  expect(await activateAiVaultStructuredSession(pointer)).toBe(true)
  expect(mocks.activateTab).toHaveBeenCalledWith('wrong-local', { worktreeId: 'workspace' })
  expect(mocks.supports).not.toHaveBeenCalled()
})

it('shares one result and the first presentation across History and neutral callers, then permits retry', async () => {
  const pointer = { workspaceId: 'workspace', sessionId: 'coalesced' }
  const release = Promise.withResolvers<'gone'>()
  const parts = {
    activate: vi.fn(() => false),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(() => release.promise),
    gone: vi.fn(),
    unavailable: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  const present = vi.fn()
  const history = activateAiVaultStructuredSession({ structuredSession: pointer }, parts, TARGET)
  const joined = openExistingStructuredSession(pointer, { target: TARGET, deps: parts, present })
  release.resolve('gone')
  expect(await history).toBe(true)
  expect(await joined).toBe('gone')
  expect(parts.reveal).toHaveBeenCalledOnce()
  expect(parts.gone).toHaveBeenCalledOnce()
  expect(present).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<'gone'>()
  parts.reveal.mockImplementationOnce(() => pending.promise)
  const neutral = openExistingStructuredSession(pointer, { target: TARGET, deps: parts, present })
  const historyJoin = activateAiVaultStructuredSession(
    { structuredSession: pointer },
    parts,
    TARGET
  )
  pending.resolve('gone')
  expect(await neutral).toBe('gone')
  expect(await historyJoin).toBe(true)
  expect(present).toHaveBeenCalledExactlyOnceWith('gone')
  expect(parts.gone).toHaveBeenCalledOnce()
})

it('releases a rejected interaction without converting an unexpected dependency failure into handled success', async () => {
  const pointer = { workspaceId: 'workspace', sessionId: 'rejected' }
  const parts = {
    activate: vi.fn(() => false),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(async () => {
      throw new Error('dependency failure')
    }),
    gone: vi.fn(),
    unavailable: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  const onError = vi.fn()
  const first = openExistingStructuredSession(pointer, {
    target: TARGET,
    deps: parts,
    present: vi.fn(),
    onError
  })
  const joined = activateAiVaultStructuredSession({ structuredSession: pointer }, parts, TARGET)
  await expect(first).rejects.toThrow('dependency failure')
  await expect(joined).rejects.toThrow('dependency failure')
  expect(onError).toHaveBeenCalledOnce()
  expect(parts.unavailable).not.toHaveBeenCalled()
  parts.activate.mockReturnValue(true)
  expect(
    await activateAiVaultStructuredSession({ structuredSession: pointer }, parts, TARGET)
  ).toBe(true)
})

it('preserves History success-only navigation, the active-workspace shortcut and moved-workspace fallback', async () => {
  const session = { structuredSession: { workspaceId: 'workspace', sessionId: 'nav' } }
  const parts = {
    activate: vi.fn(() => false),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(async () => 'gone' as const),
    gone: vi.fn(),
    unavailable: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  mocks.state.activeWorktreeId = 'elsewhere'
  expect(await activateAiVaultStructuredSession(session, parts, TARGET)).toBe(true)
  expect(parts.gone).toHaveBeenCalledOnce()
  expect(mocks.navigate).not.toHaveBeenCalled()
  expect(mocks.moved).not.toHaveBeenCalled()
  parts.activate.mockReturnValue(true)
  await activateAiVaultStructuredSession(session, parts, TARGET)
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('workspace')
  mocks.navigate.mockClear()
  mocks.moved.mockReturnValue(true)
  await activateAiVaultStructuredSession(session, parts, TARGET)
  expect(mocks.navigate).not.toHaveBeenCalled()
  mocks.state.activeWorktreeId = 'workspace'
  mocks.moved.mockClear()
  await activateAiVaultStructuredSession(session, parts, TARGET)
  expect(mocks.moved).not.toHaveBeenCalled()
})
