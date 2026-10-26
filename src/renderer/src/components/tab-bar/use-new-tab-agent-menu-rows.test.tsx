// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  subscribe: vi.fn(),
  publishing: false,
  catalog: vi.fn(),
  failed: vi.fn(),
  load: vi.fn(),
  detection: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: mocks.subscribe }))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.support
}))
// Like the real hook: a closed menu acquires nothing, and the stored inventory stays.
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: mocks.detection
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgents: mocks.catalog,
  readHostStructuredAgentsForRuntime: mocks.catalog,
  hostStructuredAgentsReadFailed: mocks.failed,
  loadHostStructuredAgents: mocks.load,
  relearnHostStructuredAgents: mocks.load,
  hostStructuredAgentsVersion: () => 0,
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  workspaceKindForWorktreeId: () => 'git-worktree',
  resolveAgentLaunchHost: () => ({
    executionHostId: 'local',
    hostCapabilities:
      readLocalRuntimeCapabilitiesOrUnknown() === null
        ? null
        : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])]
  }),
  buildAgentLaunchRouteInput: (_state: unknown, { agent }: { agent: string }) => ({
    agent,
    executionHostId: 'local',
    hostCapabilities:
      readLocalRuntimeCapabilitiesOrUnknown() === null
        ? null
        : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])],
    clientCapabilities: [CHAT, CLIENT],
    hostStructuredAgents: ['claude', 'codex', 'opencode']
  })
}))
import { useAgentMenuObservation, useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.support.mockReset()
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  mocks.publishing = false
  mocks.catalog
    .mockReset()
    .mockReturnValue(['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} })))
  mocks.failed.mockReset().mockReturnValue(false)
  mocks.load.mockReset().mockResolvedValue(undefined)
  mocks.detection
    .mockReset()
    .mockReturnValue({ detectedIds: ['claude', 'codex', 'opencode', 'gemini'] })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, CATALOG])
  useAppStore.setState({
    ...initial,
    activeWorktreeId: 'one',
    settings: {
      ...getDefaultSettings('/home/me'),
      experimentalNativeChat: true,
      disabledTuiAgents: []
    },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    detectedAgentIds: ['claude', 'codex', 'opencode']
  })
})
afterEach(cleanup)

it("reads a publishing host's one snapshot, holding a placeholder only until it lands", async () => {
  mocks.publishing = true
  mocks.catalog.mockReturnValue(undefined)
  const hook = renderHook(({ id }) => useNewTabAgentMenuRows(id, false, { kind: 'local' }), {
    initialProps: { id: 'one' }
  })
  const row = (agent: string) =>
    hook.result.current.state === 'settled'
      ? hook.result.current.rows.find((r) => r.agent === agent)
      : undefined
  // Held while the workspace is shown, so the first open already knows.
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(mocks.subscribe.mock.calls[0][2]).toEqual({})
  expect(hook.result.current.state).toBe('loading')
  expect(hook.result.current).not.toHaveProperty('rows')

  act(() =>
    mocks.subscribe.mock.calls[0][3].onEvent({
      type: 'availability',
      agents: [
        { agent: 'claude', state: 'refused', reason: 'agent' },
        { agent: 'codex', state: 'available' },
        { agent: 'opencode', state: 'unknown' }
      ]
    })
  )
  expect(row('claude')).toMatchObject({ reason: 'not-on-host' })
  expect(row('codex')).toMatchObject({ kind: 'chat' })

  // Another workspace on the same host reads the same snapshot at once, without a new stream.
  mocks.catalog.mockReturnValue([{ agent: 'gemini', capabilities: {} }])
  act(() => useAppStore.setState({ activeWorktreeId: 'two' }))
  hook.rerender({ id: 'two' })
  // Past the microtask a released holder closes on.
  await act(async () => {})
  expect(row('claude')).toMatchObject({ reason: 'not-on-host' })
  expect(row('gemini')).toMatchObject({ kind: 'cli' })
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(mocks.support).not.toHaveBeenCalled()
})

it('shows an older host from client facts and never asks it per agent', () => {
  mocks.publishing = false
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(
    hook.result.current.state === 'settled' &&
      hook.result.current.rows.find((r) => r.agent === 'claude')
  ).toMatchObject({
    kind: 'chat'
  })
  expect(mocks.subscribe).not.toHaveBeenCalled()
  expect(mocks.support).not.toHaveBeenCalled()
})

it('waits for a real catalog read, then preserves Gemini CLI after failure without retrying', () => {
  mocks.catalog.mockReturnValue(undefined)
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(mocks.load).toHaveBeenCalledTimes(1)
  mocks.failed.mockReturnValue(true)
  hook.rerender()
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'cli',
    agent: 'gemini',
    executionHostId: 'local'
  })
  expect(mocks.load).toHaveBeenCalledTimes(1)
})

it('settles an initial inventory failure despite pending health and catalog enrichment', () => {
  mocks.publishing = true
  mocks.catalog.mockReturnValue(undefined)
  mocks.detection.mockReturnValue({ detectedIds: null, detectionFailed: true })
  useAppStore.setState({ detectedAgentIds: null })
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(
    hook.result.current.state === 'settled' &&
      hook.result.current.rows.every(
        (row) => row.kind === 'chat-unavailable' && row.reason === 'check-failed'
      )
  ).toBe(true)
})

it('holds initial capability acquisition, then exposes truthful failure and known CLI without a retry loop', async () => {
  setLocalRuntimeCapabilitiesForTests(null)
  const status = Promise.withResolvers<never>()
  const getStatus = vi.fn(() => status.promise)
  Object.assign(window, { api: { runtime: { getStatus } } })
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  await act(async () => {
    status.reject(new Error('host unreachable'))
  })
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'chat-unavailable',
    agent: 'claude',
    reason: 'check-failed',
    executionHostId: 'local'
  })
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'cli',
    agent: 'gemini',
    executionHostId: 'local'
  })
  expect(getStatus).toHaveBeenCalledTimes(1)
})

// Last: the host's published snapshot is module state that later cases would read.
it('picks a host-run chat without its CLI, but never its terminal', () => {
  mocks.publishing = true
  mocks.detection.mockReturnValue({ detectedIds: ['claude'] })
  const hook = renderHook(() => useAgentMenuObservation('one', true, { kind: 'local' }))
  act(() =>
    mocks.subscribe.mock.calls[0][3].onEvent({
      type: 'availability',
      agents: [{ agent: 'codex', state: 'available', chatProgram: 'installable' }]
    })
  )
  const { model, selectionFor } = hook.result.current
  const rows = model.state === 'settled' ? model.rows : []
  expect(rows).toContainEqual({ kind: 'chat', agent: 'codex', executionHostId: 'local' })
  const chat = selectionFor('codex', 'chat')
  expect(chat.ready && chat.choice?.route).toBe('structured-native-chat')
  expect(selectionFor('codex', 'terminal').ready).toBe(false)
})
