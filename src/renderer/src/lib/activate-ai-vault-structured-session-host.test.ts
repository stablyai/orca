import { toast } from 'sonner'
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
import {
  activateAiVaultStructuredSession,
  openDesktopStructuredSession
} from './activate-ai-vault-structured-session'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/agent-session/structured-agent-session-surface-capabilities'

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

it.each([false, true])(
  'keeps the known host through lineage/refresh/reveal/activation without applying its snapshot as local; older lookup=%s',
  async (olderLookup) => {
    if (olderLookup) {
      const call = mocks.call.getMockImplementation()!
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === 'orchestration.partyLocation') {
          throw Object.assign(new Error('old host'), { code: 'method_not_found' })
        }
        return call(...args)
      })
    }
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
      [TARGET, 'orchestration.partyLocation'],
      [TARGET, 'agentSession.reveal'],
      [TARGET, 'session.tabs.list'],
      [TARGET, 'session.tabs.activate']
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.activateTab).toHaveBeenCalledOnce()
    expect(mocks.activateTab).toHaveBeenCalledWith('right-remote', { worktreeId: 'workspace' })
  }
)

it('a listed exact History view selects while lookup is unavailable and never starts it', async () => {
  mocks.state.unifiedTabsByWorktree.workspace.push(tab('right-remote', 'runtime:remote-2'))
  mocks.call.mockImplementation(async (_host, method) => {
    if (method === 'orchestration.partyLocation') {
      return new Promise(() => {})
    }
    return { ok: true }
  })
  await activateAiVaultStructuredSession(
    { structuredSession: { sessionId: 'sender', workspaceId: 'workspace' } },
    undefined,
    TARGET
  )
  expect(mocks.activateTab).toHaveBeenCalledWith('right-remote', { worktreeId: 'workspace' })
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual(['session.tabs.activate'])
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

it.each([false, true])(
  'shares semantic settlements and first presentation; History first=%s',
  async (historyFirst) => {
    for (const [reply, outcome, feedback] of [
      ['gone', 'gone', 'gone'],
      ['host-cannot-open', 'host-cannot-open', 'hostCannotOpen'],
      ['unreachable', 'unavailable', 'unavailable'],
      ['opened', 'activated', null]
    ] as const) {
      const pointer = { workspaceId: 'workspace', sessionId: 'coalesced' }
      const release = Promise.withResolvers<void>()
      let rows: { id: string; sessionId: string; agent: string }[] = []
      const parts = {
        tabs: () => rows,
        activate: vi.fn(() => true),
        refresh: vi.fn(async () => undefined),
        reveal: vi.fn(async () => {
          await release.promise
          if (reply !== 'opened') {
            return reply
          }
          rows = [{ id: 'issued', sessionId: 'coalesced', agent: 'codex' }]
          return { sessionId: 'coalesced', worktreeId: 'workspace', agent: 'codex' }
        }),
        gone: vi.fn(),
        unavailable: vi.fn(),
        hostCannotOpen: vi.fn()
      }
      mocks.call.mockImplementation(async () => ({
        location: { kind: 'chat', sessionId: pointer.sessionId, worktreeId: pointer.workspaceId }
      }))
      const present = vi.fn()
      const onError = vi.fn()
      const history = () =>
        activateAiVaultStructuredSession({ structuredSession: pointer }, parts, TARGET)
      const neutral = () =>
        openExistingStructuredSession(pointer, { target: TARGET, deps: parts, present, onError })
      const first = historyFirst ? history() : neutral()
      const joined = historyFirst ? neutral() : history()
      release.resolve()
      expect(await first).toBe(historyFirst ? true : outcome)
      expect(await joined).toBe(historyFirst ? outcome : true)
      expect(parts.reveal).toHaveBeenCalledOnce()
      expect(present).toHaveBeenCalledTimes(historyFirst ? 0 : 1)
      if (!historyFirst) {
        expect(present.mock.calls[0]?.[0]).toBe(outcome)
      }
      for (const key of ['gone', 'unavailable', 'hostCannotOpen'] as const) {
        expect(parts[key]).toHaveBeenCalledTimes(historyFirst && feedback === key ? 1 : 0)
      }
      expect(onError).not.toHaveBeenCalled()
      rows = [{ id: 'retry', sessionId: 'coalesced', agent: 'codex' }]
      expect(await neutral()).toBe('activated')
      expect(parts.reveal).toHaveBeenCalledOnce()
    }
  }
)

it.each([false, true])(
  'normalizes a reveal throw with first-owner feedback; History first=%s',
  async (historyFirst) => {
    const pointer = { workspaceId: 'workspace', sessionId: 'rejected' }
    mocks.call.mockImplementation(async () => ({
      location: { kind: 'chat', sessionId: pointer.sessionId, worktreeId: pointer.workspaceId }
    }))
    const release = Promise.withResolvers<void>()
    const parts = {
      tabs: vi.fn((): { id: string; sessionId: string }[] => []),
      activate: vi.fn(() => true),
      refresh: vi.fn(async () => undefined),
      reveal: vi.fn(async () => {
        await release.promise
        throw new Error('dependency failure')
      }),
      gone: vi.fn(),
      unavailable: vi.fn(),
      hostCannotOpen: vi.fn()
    }
    const present = vi.fn()
    const onError = vi.fn()
    const history = () =>
      activateAiVaultStructuredSession({ structuredSession: pointer }, parts, TARGET)
    const neutral = () =>
      openExistingStructuredSession(pointer, { target: TARGET, deps: parts, present, onError })
    const first = historyFirst ? history() : neutral()
    const joined = historyFirst ? neutral() : history()
    const rich = openDesktopStructuredSession(
      { kind: 'history', structuredSession: pointer },
      TARGET,
      parts
    )
    release.resolve()
    expect(await first).toBe(historyFirst ? true : 'unavailable')
    expect(await joined).toBe(historyFirst ? 'unavailable' : true)
    expect(await rich).toEqual({
      kind: 'failed',
      failure: { reason: 'unreachable', beforeEffects: false }
    })
    expect(parts.reveal).toHaveBeenCalledOnce()
    expect(parts.refresh).toHaveBeenCalledOnce()
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'orchestration.partyLocation')
    ).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(parts.unavailable).toHaveBeenCalledTimes(historyFirst ? 1 : 0)
    expect(present).toHaveBeenCalledTimes(historyFirst ? 0 : 1)
    if (!historyFirst) {
      expect(present).toHaveBeenCalledWith('unavailable', await rich)
    }
    parts.tabs.mockReturnValue([{ id: 'retry', sessionId: pointer.sessionId }])
    expect(await neutral()).toBe('activated')
    expect(parts.reveal).toHaveBeenCalledOnce()
  }
)

it('preserves History success-only navigation, the active-workspace shortcut and moved-workspace fallback', async () => {
  const session = { structuredSession: { workspaceId: 'workspace', sessionId: 'nav' } }
  const parts = {
    tabs: vi.fn((): { id: string; sessionId: string }[] => []),
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
  parts.tabs.mockReturnValue([{ id: 'nav', sessionId: 'nav' }])
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

it.each(['present', 'initialize', 'onError'] as const)(
  'releases after %s throws with the exact single callback boundary',
  async (boundary) => {
    const pointer = { workspaceId: 'workspace', sessionId: 'callback' }
    const failure = new Error(boundary)
    const setupFailure = new Error('setup')
    const parts = {
      tabs: () => [{ id: 'callback-tab', sessionId: pointer.sessionId }],
      activate: vi.fn(() => true),
      refresh: vi.fn(async () => undefined),
      reveal: vi.fn(async () => 'gone' as const)
    }
    const present = vi.fn(() => {
      if (boundary === 'present') {
        throw failure
      }
    })
    const initialize = vi.fn(() => {
      if (boundary !== 'present') {
        throw boundary === 'initialize' ? failure : setupFailure
      }
      return true
    })
    const onError = vi.fn(() => {
      if (boundary === 'onError') {
        throw failure
      }
    })
    const joiningPresent = vi.fn()
    const joiningInitialize = vi.fn(() => true)
    const joiningError = vi.fn()
    const first = openExistingStructuredSession(pointer, {
      target: TARGET,
      deps: parts,
      initialize,
      present,
      onError
    })
    const joined = openExistingStructuredSession(pointer, {
      target: TARGET,
      deps: parts,
      initialize: joiningInitialize,
      present: joiningPresent,
      onError: joiningError
    })
    await Promise.all([expect(first).rejects.toBe(failure), expect(joined).rejects.toBe(failure)])
    expect(initialize).toHaveBeenCalledOnce()
    expect(present).toHaveBeenCalledTimes(boundary === 'present' ? 1 : 0)
    expect(onError).toHaveBeenCalledTimes(boundary === 'present' ? 0 : 1)
    expect(joiningInitialize).not.toHaveBeenCalled()
    expect(joiningPresent).not.toHaveBeenCalled()
    expect(joiningError).not.toHaveBeenCalled()
    expect(
      await openExistingStructuredSession(pointer, {
        target: TARGET,
        deps: parts,
        present: joiningPresent
      })
    ).toBe('activated')
    expect(joiningPresent).toHaveBeenCalledOnce()
  }
)

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

it('keeps advisory refresh rejection semantic and continues to a real revealed row', async () => {
  let rows: { id: string; sessionId: string }[] = []
  const parts = {
    tabs: () => rows,
    activate: vi.fn(() => true),
    refresh: vi.fn(async () => {
      throw new Error('advisory')
    }),
    reveal: vi.fn(async () => {
      rows = [{ id: 'actual', sessionId: 'sender' }]
      return { worktreeId: 'workspace', sessionId: 'sender', agent: 'codex' }
    }),
    unavailable: vi.fn(),
    gone: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  expect(
    await openDesktopStructuredSession(
      { kind: 'history', structuredSession: { workspaceId: 'workspace', sessionId: 'sender' } },
      TARGET,
      parts
    )
  ).toEqual({
    kind: 'opened',
    target: { worktreeId: 'workspace', sessionId: 'sender', agent: 'codex' },
    tab: { id: 'actual', sessionId: 'sender' }
  })
  expect(parts.reveal).toHaveBeenCalledOnce()
  expect(parts.unavailable).not.toHaveBeenCalled()
})

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

it('consumes removed-workspace reveal once with existing workspace feedback and no presentation', async () => {
  mocks.call.mockImplementation(async (_host, method) =>
    method === 'orchestration.partyLocation'
      ? { location: { kind: 'chat', sessionId: 'sender', worktreeId: 'workspace' } }
      : method === 'agentSession.reveal'
        ? { ok: false, refusal: { code: 'agent_session_workspace_removed' } }
        : { ok: true }
  )
  expect(
    await activateAiVaultStructuredSession(
      { structuredSession: { sessionId: 'sender', workspaceId: 'workspace' } },
      undefined,
      TARGET
    )
  ).toBe(true)
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('This workspace is no longer available.')
  expect(mocks.navigate).not.toHaveBeenCalled()
  expect(mocks.activateTab).not.toHaveBeenCalled()
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual([
    'session.tabs.list',
    'orchestration.partyLocation',
    'agentSession.reveal'
  ])
})
