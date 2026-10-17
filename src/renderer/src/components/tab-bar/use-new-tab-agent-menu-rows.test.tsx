// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { HostCreateSupport } from '@/lib/structured-agent-session-host-admission'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
const mocks = vi.hoisted<{
  support: ReturnType<typeof vi.fn>
  availability: HostStructuredAgentAvailability | null
  owners: unknown[]
}>(() => ({ support: vi.fn(), availability: null, owners: [] }))
vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: (owner: unknown) => {
    mocks.owners.push(owner)
    return owner ? mocks.availability : null
  }
}))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.support
}))
// Like the real hook: a closed menu acquires nothing, and the stored inventory stays.
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => ({
    detectedIds: target === undefined ? null : ['claude', 'codex', 'opencode']
  })
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => null,
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgents: () =>
    ['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} })),
  hostStructuredAgentsVersion: () => 0,
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  workspaceKindForWorktreeId: () => 'git-worktree',
  buildAgentLaunchRouteInput: (
    state: ReturnType<typeof useAppStore.getState>,
    { agent }: { agent: string }
  ) => ({
    agent,
    executionHostId: state.activeWorkspaceExecutionHostId ?? 'local',
    hostCapabilities: [CHAT, CLIENT, CATALOG, ...(mocks.availability ? [AVAILABILITY] : [])],
    clientCapabilities: [CHAT, CLIENT],
    hostStructuredAgents: ['claude', 'codex', 'opencode']
  })
}))
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
const initial = useAppStore.getState()
const pending: { resolve: (answer: HostCreateSupport) => void; signal: AbortSignal }[] = []
beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  mocks.availability = null
  mocks.owners.length = 0
  mocks.support
    .mockReset()
    .mockImplementation(
      (_target, _selector, _agent, options) =>
        new Promise<HostCreateSupport>((resolve) =>
          pending.push({ resolve, signal: options.signal })
        )
    )
  useAppStore.setState({
    ...initial,
    settings: {
      ...getDefaultSettings('/home/me'),
      experimentalNativeChat: true,
      disabledTuiAgents: []
    },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    detectedAgentIds: ['claude', 'codex', 'opencode']
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it.each(['local', 'runtime:server'] as const)(
  'shows host refusals, keeps them across reopen and never blocks a supported chat on %s',
  async (host) => {
    useAppStore.setState({ activeWorkspaceExecutionHostId: host })
    const hook = renderHook(({ open, id }) => useNewTabAgentMenuRows(id, open, { kind: 'local' }), {
      initialProps: { open: false, id: 'one' }
    })
    const claude = () => hook.result.current.rows.find((row) => row.agent === 'claude')
    expect(mocks.support).not.toHaveBeenCalled()
    hook.rerender({ open: true, id: 'one' })
    // Until the host answers, the row waits disabled instead of flipping once it does.
    expect(claude()).toMatchObject({ kind: 'chat-unavailable', reason: 'pending' })
    await act(async () => {
      pending[0]?.resolve({ kind: 'declined', reason: 'wsl' })
      pending[1]?.resolve({ kind: 'declined', reason: 'unsupported-version' })
    })
    expect(
      hook.result.current.rows.map((row) => ('reason' in row ? row.reason : row.kind))
    ).toEqual(expect.arrayContaining(['wsl', 'not-on-host', 'cli']))
    // Another tab group on the same workspace shows the host's answer at once.
    const sibling = renderHook(() => useNewTabAgentMenuRows('one', false, { kind: 'local' }))
    expect(sibling.result.current.rows.find((row) => row.agent === 'claude')).toMatchObject({
      reason: 'wsl'
    })
    sibling.unmount()
    hook.rerender({ open: false, id: 'one' })
    expect(pending[2]?.signal.aborted).toBe(true)
    hook.rerender({ open: true, id: 'one' })
    expect(claude()).toMatchObject({ reason: 'wsl' })
    act(() => useAppStore.setState({ activeTabId: 'unrelated' }))
    hook.rerender({ open: true, id: 'two' })
    expect(pending[3]?.signal.aborted).toBe(true)
    hook.rerender({ open: false, id: 'two' })
    hook.rerender({ open: true, id: 'two' })
    // A reply from the closed menu, or a host past its deadline, never relabels a row.
    await act(async () => pending[6]?.resolve({ kind: 'declined', reason: 'wsl' }))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(pending[9]?.signal.aborted).toBe(true)
    expect(claude()).toMatchObject({ kind: 'chat' })
    expect(mocks.support).toHaveBeenCalledTimes(12)
    // A host without the availability capability is never subscribed to.
    expect(mocks.owners.every((owner) => owner === null)).toBe(true)
  }
)

it('keeps a supported chat clickable when the host cannot answer', async () => {
  const hook = renderHook(() => useNewTabAgentMenuRows('three', true, { kind: 'local' }))
  await act(async () =>
    pending[0]?.resolve({
      kind: 'unreachable',
      code: 'runtime_unavailable',
      message: '',
      error: null
    })
  )
  expect(hook.result.current.rows.find((row) => row.agent === 'claude')).toMatchObject({
    kind: 'chat'
  })
})

it('reads a publishing host from its one complete answer and never asks per agent', () => {
  mocks.availability = { ready: false }
  const hook = renderHook(() => useNewTabAgentMenuRows('four', true, { kind: 'local' }))
  const claude = () => hook.result.current.rows.find((row) => row.agent === 'claude')
  expect(claude()).toMatchObject({ kind: 'chat-unavailable', reason: 'pending' })
  mocks.availability = {
    ready: true,
    byAgent: new Map([['claude', { agent: 'claude', state: 'refused', reason: 'wsl' }]])
  }
  hook.rerender()
  expect(claude()).toMatchObject({ reason: 'wsl' })
  expect(hook.result.current.rows.find((row) => row.agent === 'codex')).toMatchObject({
    kind: 'chat'
  })
  expect(mocks.support).not.toHaveBeenCalled()
})
