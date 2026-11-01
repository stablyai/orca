// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Observation from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  readLocalRuntimeCapabilityObservation,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import { TooltipProvider } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { RuntimeApi } from '../../../preload/api/runtime-api'
import type { RuntimeRpcSuccess } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { AgentSessionAgentsResult } from '../../../shared/agent-session/agent-session-registered-agents'
import type { AgentSessionAvailabilityFrame } from '../../../shared/agent-session-agent-availability'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import {
  readHostStructuredAgentsForRuntime,
  hostStructuredAgentsReadFailed,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { readAgentLaunchChoice } from '@/lib/host-chat-program'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'

const mocks = vi.hoisted(() => ({
  observe: vi.fn<typeof Observation.useAgentMenuObservation>(),
  failed: false,
  submit: vi.fn(),
  host: 'local',
  availability: vi.fn<() => HostStructuredAgentAvailability>()
}))
vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof Observation>()
  mocks.observe.mockImplementation(actual.useAgentMenuObservation)
  return { ...actual, useAgentMenuObservation: mocks.observe }
})
vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: mocks.availability
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: mocks.failed ? null : ['claude', 'opencode'],
    isLoading: false,
    detectionFailed: mocks.failed,
    needsServerUpdate: false
  })
}))
vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => ({
    cardProps: {
      projectOptions: [],
      selectedRepoIsGit: true,
      detectedAgentIds: new Set(['claude', 'opencode']),
      agentRows: {
        target: { workspace: { kind: 'git-worktree', executionHostId: mocks.host } },
        detectionTarget: { kind: 'local' }
      }
    },
    composerRef: useRef(null),
    submitQuick: mocks.submit,
    createDisabled: false
  })
}))
// Keep the actual owner/handler and picker; unrelated project/name fields are outside this seam.
vi.mock('@/components/NewWorkspaceComposerCard', () => ({
  default: (p: NewWorkspaceComposerCardProps) => (
    <div ref={p.composerRef}>
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={p.quickAgent}
        onValueChange={p.onQuickAgentChange}
        allowBlankTerminal
        surfaceRows={p.agentSurfaceRows}
      />
      <button onClick={p.onCreate} disabled={p.createDisabled}>
        Create
      </button>
      <button onClick={() => p.onQuickAgentChange(null)}>Blank</button>
      <button onClick={p.onQuickSetupOnlySelect}>Setup only</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'terminal')}>Choose CLI</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'chat')}>Choose chat</button>
    </div>
  )
}))
type LocalRuntime = Pick<RuntimeApi['runtime'], 'getStatus' | 'call' | 'subscribe'>
type AvailabilityCallback = Parameters<LocalRuntime['subscribe']>[1]
const status = createCompatibleRuntimeStatusResponse('composer-local').result
const catalog: RuntimeRpcSuccess<AgentSessionAgentsResult> = {
  id: 'agents',
  ok: true,
  _meta: { runtimeId: 'composer-local' },
  result: {
    agents: ['claude', 'opencode'].map((agent) => ({
      agent,
      capabilities: {
        rewind: false,
        compact: false,
        threadGoal: false,
        contextUsage: false,
        imagePrompts: false,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    }))
  }
}
let statusReply: ReturnType<typeof Promise.withResolvers<RuntimeStatus>>
const streams: {
  callback: AvailabilityCallback
  handle: Awaited<ReturnType<LocalRuntime['subscribe']>>
  unsubscribe: ReturnType<typeof vi.fn>
}[] = []
const transport: LocalRuntime = {
  getStatus: vi.fn<LocalRuntime['getStatus']>(() => statusReply.promise),
  call: vi.fn<LocalRuntime['call']>(async (args) => {
    expect(args).toEqual({ method: 'agentSession.agents', params: {} })
    return catalog
  }),
  subscribe: vi.fn<LocalRuntime['subscribe']>(async (args, callback) => {
    expect(args).toEqual({ method: 'agentSession.subscribeAvailability', params: {} })
    const unsubscribe = vi.fn()
    const handle: Awaited<ReturnType<LocalRuntime['subscribe']>> = {
      unsubscribe,
      sendBinary: vi.fn(() => {
        throw new Error('Local runtime subscriptions do not accept binary input')
      })
    }
    streams.push({ callback, handle, unsubscribe })
    return handle
  })
}
let previousApi: PropertyDescriptor | undefined
let previousCapabilities: ReturnType<typeof readLocalRuntimeCapabilitiesOrUnknown>
async function receive(frame: AgentSessionAvailabilityFrame, from = 0) {
  await waitFor(() =>
    expect(streams.slice(from).some(({ unsubscribe }) => !unsubscribe.mock.calls.length)).toBe(true)
  )
  await act(async () => {
    const response: RuntimeRpcSuccess<AgentSessionAvailabilityFrame> = {
      id: 'availability',
      ok: true,
      result: frame,
      _meta: { runtimeId: 'composer-local' }
    }
    for (const stream of streams.slice(from)) {
      if (!stream.unsubscribe.mock.calls.length) {
        stream.callback(response)
      }
    }
  })
}
async function expectCatalog() {
  await waitFor(() =>
    expect(readHostStructuredAgentsForRuntime('local', null)).toEqual(catalog.result.agents)
  )
  expect(hostStructuredAgentsReadFailed('local', null)).toBe(false)
  expect(transport.call).toHaveBeenCalledWith({ method: 'agentSession.agents', params: {} })
}
const initial = useAppStore.getState()
beforeEach(() => {
  previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  previousCapabilities = readLocalRuntimeCapabilitiesOrUnknown()
  statusReply = Promise.withResolvers<RuntimeStatus>()
  streams.length = 0
  vi.mocked(transport.getStatus).mockClear()
  vi.mocked(transport.call).mockClear()
  vi.mocked(transport.subscribe).mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: { runtime: transport } })
  mocks.observe.mockClear()
  mocks.failed = false
  mocks.submit.mockReset()
  mocks.host = 'local'
  mocks.availability.mockReturnValue({ state: 'pending' })
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: {},
    settings: {
      ...getDefaultSettings('/test'),
      nativeChatProviders: EVERY_AGENT_CHAT,
      defaultTuiAgent: 'claude'
    }
  })
})
afterEach(async () => {
  try {
    await act(async () => {
      cleanup()
      statusReply.resolve(status)
      await Promise.all([
        ...vi
          .mocked(transport.getStatus)
          .mock.results.filter((result) => result.type === 'return')
          .map((result) => result.value),
        ...vi
          .mocked(transport.call)
          .mock.results.filter((result) => result.type === 'return')
          .map((result) => result.value),
        ...vi
          .mocked(transport.subscribe)
          .mock.results.filter((result) => result.type === 'return')
          .map((result) => result.value)
      ])
    })
    for (const stream of streams) {
      expect(stream.unsubscribe).toHaveBeenCalledOnce()
      expect(stream.handle.sendBinary).not.toHaveBeenCalled()
    }
  } finally {
    resetHostStructuredAgentsForTests()
    useAppStore.setState(initial, true)
    setLocalRuntimeCapabilitiesForTests(previousCapabilities)
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
})
const create = () => screen.getByRole('button', { name: 'Create' })
const submit = async () => {
  await act(async () => fireEvent.click(create()))
}

it.each(['chat', 'terminal'] as const)(
  'gates explicit selections over default %s, preserves terminal and blank exceptions, and repairs host changes',
  async (agentDefaultSurface) => {
    setLocalRuntimeCapabilitiesForTests(null)
    const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
    expect(mocks.observe).toHaveBeenLastCalledWith(
      { workspace: { kind: 'git-worktree', executionHostId: 'local' } },
      true,
      { kind: 'local' },
      false,
      { wakeOnOpen: true }
    )
    expect(create().hasAttribute('disabled')).toBe(true)
    await submit()
    fireEvent.keyDown(create(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(create(), { key: 'Enter', metaKey: true })
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(readLocalRuntimeCapabilityObservation().state).toBe('pending')
    expect(transport.getStatus).toHaveBeenCalledOnce()
    await act(async () => {
      setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
      statusReply.resolve(status)
      await statusReply.promise
    })
    await expectCatalog()
    fireEvent.click(screen.getByText('Blank'))
    await submit()
    expect(mocks.submit).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ setupOnly: false })
    )
    fireEvent.click(screen.getByText('Setup only'))
    await submit()
    expect(mocks.submit).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ setupOnly: true })
    )
    fireEvent.click(screen.getByText('Choose CLI'))
    expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    })
    mocks.availability.mockReturnValue({
      state: 'received',
      byAgent: new Map([['claude', { agent: 'claude', state: 'available' }]])
    })
    await receive({ type: 'availability', agents: [{ agent: 'claude', state: 'available' }] })
    fireEvent.click(screen.getByText('Choose chat'))
    // Another window changes the default/override after the user explicitly picked Chat.
    act(() =>
      useAppStore.setState((state) => ({
        settings: {
          ...state.settings!,
          agentDefaultSurface,
          nativeChatProviders: { claude: false }
        }
      }))
    )
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'structured-native-chat',
      requestedSurface: 'chat'
    })
    mocks.host = 'ssh:other'
    view.rerender(<NewWorkspaceComposerModal />)
    expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    })
  }
)

it('submits the untouched refusal-aware OpenCode CLI instead of the registered catalog chat', async () => {
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['opencode', { agent: 'opencode', state: 'refused' }]])
  })
  const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  act(() =>
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/test'),
        nativeChatProviders: EVERY_AGENT_CHAT,
        defaultTuiAgent: 'opencode'
      }
    })
  )
  await expectCatalog()
  await receive({ type: 'availability', agents: [{ agent: 'opencode', state: 'refused' }] })
  expect(
    readAgentLaunchChoice(
      useAppStore.getState(),
      'opencode',
      { kind: 'git-worktree', executionHostId: 'local' },
      ['claude', 'opencode']
    )
  ).toMatchObject({ catalogReady: true, chatEligibility: 'opens' })
  expect(screen.getByRole('combobox').textContent).toContain('OpenCode (CLI)')
  await submit()
  expect(mocks.submit.mock.calls[0][1].launchChoice).toMatchObject({
    agent: 'opencode',
    route: 'terminal-tui'
  })
  expect(mocks.submit.mock.calls[0][1].launchChoice.requestedSurface).toBeUndefined()
  mocks.failed = true
  view.rerender(<NewWorkspaceComposerModal />)
  const observed = mocks.observe.mock.results.at(-1)?.value
  expect(observed?.model.state).toBe('settled')
  if (!observed || observed.model.state !== 'settled') {
    throw new Error('Expected settled observation')
  }
  expect(observed.model.rows.filter((row: { kind: string }) => row.kind === 'cli')).toEqual([])
  const callsBeforeClose = mocks.observe.mock.calls.length
  const streamsBeforeClose = streams.length
  const submitsBeforeClose = mocks.submit.mock.calls.length
  await act(async () => useAppStore.getState().closeModal())
  expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(mocks.observe).toHaveBeenCalledTimes(callsBeforeClose)
  for (const stream of streams) {
    expect(stream.unsubscribe).toHaveBeenCalledOnce()
  }
  await act(async () => useAppStore.setState({ activeModal: 'new-workspace-composer' }))
  expect(mocks.observe.mock.calls.length).toBeGreaterThan(callsBeforeClose)
  expect(mocks.observe.mock.calls[callsBeforeClose]).toEqual([
    { workspace: { kind: 'git-worktree', executionHostId: 'local' } },
    true,
    { kind: 'local' },
    false,
    { wakeOnOpen: true }
  ])
  expect(create()).toBeTruthy()
  expect(screen.getByRole('combobox')).toBeTruthy()
  await receive(
    { type: 'availability', agents: [{ agent: 'opencode', state: 'refused' }] },
    streamsBeforeClose
  )
  const reopened = mocks.observe.mock.results.at(-1)?.value
  expect(reopened?.model.state).toBe('settled')
  if (!reopened || reopened.model.state !== 'settled') {
    throw new Error('Expected reopened settled observation')
  }
  expect(reopened.model.rows.filter((row: { kind: string }) => row.kind === 'cli')).toEqual([])
  expect(mocks.submit).toHaveBeenCalledTimes(submitsBeforeClose)
})
