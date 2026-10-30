// @vitest-environment happy-dom
import {
  fakeCodex,
  THREAD_ID as CODEX_THREAD_ID
} from '../../src/main/codex/codex-structured-session-adapter-fixture'
import { structuredAgentRuntimeRegistration } from '../../src/main/runtime/structured-agent-runtime-registrations'
import { createStructuredAgentEnvironmentResolvers } from '../../src/main/runtime/structured-agent-shell-environment'
import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SDKStatusMessage } from '@anthropic-ai/claude-agent-sdk'
const transport = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: transport.call,
  subscribeStructuredAgentSessionStatus: transport.subscribe
}))
import { useStructuredAgentSessionOptions } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-options'
import { loadMobileStructuredOptions } from './__mocks__/mobile-structured-options'
const useMobileStructuredAgentOptions = await loadMobileStructuredOptions()
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import {
  adapterAtPublishFor,
  fakeClaude,
  claudeFrame,
  USER_MESSAGE,
  PROVIDER_SESSION_ID
} from '../../src/main/claude/claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from '../../src/main/claude/structured/claude-structured-session-state'
import { structuredClaudeLifecycleEvent } from '../../src/main/runtime/structured-claude-runtime-adapter'
import {
  hostTestState,
  attachParams,
  envelope,
  CALLER
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as sessionId
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../src/shared/agent-session-permission-modes-capability'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { acpLaunchSpecFor } from '../../src/main/acp/acp-launch-specs'
import { openHostRig, launch } from '../../src/main/acp/acp-structured-host.test-support'
import { GROK_CONFIG_OPTIONS } from '../../src/main/acp/acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../../src/main/native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'

import { agentSessionRefusalFailure } from '../../src/shared/agent-session-write-failure'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW))
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection(sessionId)
  vi.restoreAllMocks()
})

afterEach(closeProviderTimelineRigs)

function permissionConsumersFor(
  host: StructuredAgentSessionHost,
  agent: string,
  fence: number,
  count = 1
) {
  let id = 0
  const subscriptions: (() => void)[] = []
  const subscribe = (emit: Parameters<typeof host.subscribeStatus>[0]['emit']) => {
    const key = `view-${id++}`
    const dispose = host.subscribeStatus({ id: key, emit })
    subscriptions.push(dispose)
    return dispose
  }
  transport.subscribe.mockImplementation(async (_target, emit) => ({
    unsubscribe: subscribe(emit)
  }))
  const read = vi.fn(async (method: string, params?: Parameters<typeof host.setOption>[1]) => {
    if (method === 'agentSession.setOption' && params) {
      return write(method, method, { key: params.key, value: params.value }, params)
    }
    if (method !== 'agentSession.options') {
      return new Promise<never>(() => {})
    }
    return host.readOptions(sessionId)
  })
  transport.call.mockImplementation((_target, method, params) => read(method, params))
  const client: RpcClient = {
    getState: () => 'connected',
    onStateChange: () => () => {},
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    updateTerminalSubscriptionViewport: () => {},
    notifyForeground: () => {},
    close: () => {},
    subscribe: (_method, _params, emit) => subscribe(emit),
    sendRequest: async (method) => ({ id: 'report-rpc', ok: true, result: await read(method) })
  }
  const write = vi.fn()
  write.mockImplementation(
    async (
      _method: string,
      _fingerprint: string,
      fields: { key: string; value: string },
      params?: Parameters<typeof host.setOption>[1]
    ) => {
      return host.setOption(
        CALLER,
        params ?? {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        }
      )
    }
  )
  const phoneWrite = vi.fn()
  phoneWrite.mockImplementation(async (...args) => {
    const result = await write(...args)
    return result.ok
      ? { status: 'accepted', value: result.value, sameFence: true }
      : { status: 'rejected', failure: agentSessionRefusalFailure(result.refusal) }
  })
  const target = { kind: 'local' } as const
  const common = { agent, sessionId, fence }
  const hooks = [
    () =>
      useStructuredAgentSessionOptions({
        ...common,
        target,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        providerStarting: false,
        turnId: null,
        unloadedTurnRevisions: undefined,
        hostOptionStamp: 'model|own',
        mutate: write
      }),
    () =>
      useMobileStructuredAgentOptions({
        ...common,
        client,
        enabled: true,
        optionStamp: 'model|own',
        turnId: null,
        hostSupport: {
          permissionModes: true,
          permissionOwn: true,
          statusFeed: true,
          coherentModelCatalog: false,
          sendOptions: false
        },
        mutate: phoneWrite
      })
  ]
  const mount = () =>
    hooks.flatMap((useOptions) =>
      Array.from({ length: count }, () =>
        renderHook(() => {
          const { optionSnapshot, setStructuredOption } = useOptions()
          return { optionSnapshot, setStructuredOption }
        })
      )
    )
  return { mount, read, write, subscriptions }
}

it.each([1, 10, 100])(
  'publishes idle permission reports to %s desktop and phone consumers without readback/activity',
  async (count) => {
    const { host, store } = hostTestState()
    const events: ClaudeStructuredSessionEvent[] = []
    const claude = fakeClaude(),
      adapter = adapterAtPublishFor(claude, {}, events)
    host.deps.adapter = adapter
    const sink = { publish: vi.fn(), forget: vi.fn() },
      onStatusChanged = vi.fn()
    host.deps.statusSink = sink
    host.deps.onSessionStatusChanged = onStatusChanged
    try {
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY])
      const settlements: Promise<void>[] = []
      vi.spyOn(events, 'push').mockImplementation((...incoming) => {
        incoming.forEach((event) => {
          const lifecycle = structuredClaudeLifecycleEvent(event)
          if (lifecycle) {
            settlements.push(host.handleAdapterEvent(lifecycle))
          }
        })
        return Array.prototype.push.apply(events, incoming)
      })
      expect(
        (
          await host.attach(
            CALLER,
            attachParams({
              provider: 'claude',
              agent: 'claude',
              providerHandle: undefined,
              accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
              options: { permissionMode: 'own' }
            })
          )
        ).ok
      ).toBe(true)
      await waitFor(() =>
        expect(host.readStatusSummary(sessionId)?.hostExecutionPhase).toBe('ready')
      )
      const fence = store.getRecord(sessionId)!.lease.runtimeFence
      const connection = claude.connections[0]!
      await adapter.dispatch({
        sessionId,
        clientMessageId: 'report-turn',
        body: USER_MESSAGE,
        fence
      })
      claudeFrame(connection, {
        type: 'system',
        subtype: 'init',
        uuid: 'init',
        permissionMode: 'acceptEdits'
      })
      claudeFrame(connection, {
        type: 'result',
        subtype: 'success',
        uuid: 'result',
        is_error: false,
        result: 'done',
        stop_reason: 'end_turn',
        terminal_reason: 'completed'
      })
      claudeFrame(connection, {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'idle'
      })
      await Promise.all(settlements)
      await host.flushStreamedEvents(sessionId)
      expect(adapter['sessions'].get(sessionId)?.translator?.currentTurnId).toBeNull()
      const { mount, read, write, subscriptions } = permissionConsumersFor(
        host,
        'claude',
        fence,
        count
      )
      let views = mount()
      const descriptions = () =>
        views.map(
          (view) =>
            view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')
              ?.description
        )
      await waitFor(() => expect(descriptions()).toEqual(Array(count * 2).fill('Accept edits')))
      sink.publish.mockClear()
      onStatusChanged.mockClear()
      const unchanged = host.readStatusSummary(sessionId)!
      const saved = structuredClone(store.getRecord(sessionId))
      const publications: unknown[] = []
      subscriptions.push(
        host.subscribeStatus({
          id: 'publication-control',
          emit: (event) => {
            if (event.type === 'status') {
              publications.push(event)
            }
          }
        })
      )
      const reads = read.mock.calls.filter(([method]) => method === 'agentSession.options').length
      const frame: SDKStatusMessage = {
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: 'default',
        session_id: PROVIDER_SESSION_ID,
        uuid: 'a1111111-1111-4111-8111-111111111111'
      }
      await act(async () => {
        claudeFrame(connection, frame)
        await Promise.all(settlements)
      })
      await waitFor(() => expect(descriptions()).toEqual(Array(count * 2).fill('Ask for approval')))
      expect(read.mock.calls.filter(([method]) => method === 'agentSession.options')).toHaveLength(
        reads
      )
      expect(publications).toHaveLength(1)
      expect({
        ...host.readStatusSummary(sessionId),
        runtimePermission: unchanged.runtimePermission
      }).toEqual(unchanged)
      expect(store.getRecord(sessionId)).toEqual(saved)
      await act(async () => {
        claudeFrame(connection, { ...frame, uuid: 'b1111111-1111-4111-8111-111111111111' })
        await Promise.all(settlements)
      })
      expect(publications).toHaveLength(1)
      expect(sink.publish).not.toHaveBeenCalled()
      expect(onStatusChanged).not.toHaveBeenCalled()
      expect(store.getRecord(sessionId)?.permissionMode).toBe('own')
      const desktop = views[0],
        phone = views[count]
      if (!desktop || !phone) {
        throw new Error('Both mounted permission consumers are required')
      }
      await act(async () => {
        const applied = await desktop.result.current.setStructuredOption('permissionMode', 'ask')
        expect(
          write.mock.settledResults.at(-1)?.value,
          JSON.stringify(write.mock.settledResults.at(-1)?.value)
        ).toMatchObject({ ok: true })
        expect(applied).toBe(true)
      })
      expect(store.getRecord(sessionId)?.permissionMode).toBe('ask')
      expect(host.readStatusSummary(sessionId)?.runtimePermission).toEqual({
        fence,
        mode: 'ask'
      })
      expect((await host.readOptions(sessionId)).current).toMatchObject({
        permissionMode: 'ask',
        reportedPermissionMode: 'ask'
      })
      await waitFor(() => expect(descriptions()).toEqual(Array(count * 2).fill('Ask for approval')))
      expect(
        views.every(
          (view) =>
            view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')?.settable
        )
      ).toBe(true)
      await act(async () => {
        expect(
          await phone.result.current.setStructuredOption('permissionMode', 'full-access')
        ).toBe(true)
      })
      expect(write.mock.calls.map(([, , fields]) => fields)).toEqual([
        { key: 'permissionMode', value: 'ask' },
        { key: 'permissionMode', value: 'full-access' }
      ])
      expect(store.getRecord(sessionId)?.permissionMode).toBe('full-access')
      expect(host.readStatusSummary(sessionId)?.runtimePermission).toEqual({
        fence,
        mode: 'ask'
      })
      views.forEach((view) => view.unmount())
      views = mount()
      await waitFor(() => expect(descriptions()).toEqual(Array(count * 2).fill('Ask for approval')))
      expect((await host.readOptions(sessionId)).current).toMatchObject({
        permissionMode: 'full-access',
        reportedPermissionMode: 'ask'
      })
      await act(async () => {
        claudeFrame(connection, {
          ...frame,
          permissionMode: 'bypassPermissions',
          uuid: 'c1111111-1111-4111-8111-111111111111'
        })
        await Promise.all(settlements)
      })
      await waitFor(() => expect(descriptions()).toEqual(Array(count * 2).fill('Full access')))
      expect(
        views.every(
          (view) =>
            view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')?.settable
        )
      ).toBe(true)
      expect((await host.readOptions(sessionId)).current).toMatchObject({
        permissionMode: 'full-access',
        reportedPermissionMode: 'full-access'
      })
      expect(store.getRecord(sessionId)?.lease.runtimeFence).toBe(fence)
      await act(async () => {
        subscriptions.forEach((dispose) => dispose())
      })
      // Report loss falls back to the saved mode, which the next turn applies.
      expect(descriptions()).toEqual(Array(count * 2).fill('Full access'))
    } finally {
      cleanup()
      resetStructuredAgentSessionStatusFeedsForTests()
      resetHostModelCatalogSnapshotsForTests()
      await adapter.closeAll()
      setLocalRuntimeCapabilitiesForTests(null)
    }
  }
)

it.each([
  ...(['omp', 'grok', 'opencode', 'opencode2'] as const).flatMap((agent) =>
    (
      [
        { fullAccess: false, savedMode: 'full-access' },
        { fullAccess: true, savedMode: 'ask' }
      ] as const
    ).map((policy) => ({ agent, ...policy }))
  ),
  { agent: 'omp' as const, fullAccess: false, savedMode: 'own' as const }
])(
  'keeps $agent saved $savedMode controls tied to installed fullAccess=$fullAccess, not saved intent',
  async ({ agent, fullAccess, savedMode }) => {
    const spec = acpLaunchSpecFor(agent)
    if (!spec) {
      throw new Error('Production ACP spec is required')
    }
    expect(spec.permissionModeConfig).toBeUndefined()
    const resolved = launch(() => false, spec)
    const { host, store, rig, ready, fence } = await openHostRig({
      spec,
      deps: { resolveLaunch: async () => ({ ...(await resolved()), fullAccess }) }
    })
    const mode = fullAccess ? 'full-access' : 'ask'
    const other = fullAccess ? 'ask' : 'full-access'
    const description = fullAccess ? 'Full access' : 'Ask for approval'
    try {
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY])
      expect(
        await host.attach(
          CALLER,
          attachParams({
            provider: agent,
            agent,
            providerHandle: undefined,
            accountHome:
              'accountHomeVariable' in spec.account.pin
                ? { variable: spec.account.pin.accountHomeVariable, path: '/accounts/acp' }
                : { kind: 'opencode', locator: { kind: 'unmanaged' } },
            options: { permissionMode: savedMode }
          })
        )
      ).toMatchObject({ ok: true })
      await ready()
      const currentFence = fence()
      const { mount, write } = permissionConsumersFor(host, agent, currentFence)
      let views = mount()
      const rows = () =>
        views.map((view) =>
          view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')
        )
      await waitFor(() =>
        expect(rows().map((row) => row?.description)).toEqual([description, description])
      )
      expect(store.getRecord(sessionId)?.permissionMode).toBe(savedMode)
      expect((await host.readOptions(sessionId)).current).toMatchObject({
        permissionMode: savedMode,
        reportedPermissionMode: mode
      })
      expect(host.readStatusSummary(sessionId)?.runtimePermission).toEqual({
        fence: currentFence,
        mode
      })
      const desktop = views[0],
        phone = views[1]
      if (!desktop || !phone) {
        throw new Error('Both mounted consumers are required')
      }
      await act(async () => {
        expect(await desktop.result.current.setStructuredOption('permissionMode', mode)).toBe(true)
      })
      await act(async () => {
        expect(await phone.result.current.setStructuredOption('permissionMode', other)).toBe(true)
      })
      expect(write).toHaveBeenCalledTimes(2)
      expect(store.getRecord(sessionId)?.permissionMode).toBe(other)
      rig.child().agent.notify('session/update', {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'config_option_update', configOptions: GROK_CONFIG_OPTIONS }
      })
      await rig.settle()
      views.forEach((view) => view.unmount())
      views = mount()
      await waitFor(() =>
        expect(rows().map((row) => row?.description)).toEqual([description, description])
      )
      expect(rows().every((row) => row?.settable)).toBe(true)
      expect((await host.readOptions(sessionId)).current).toMatchObject({
        permissionMode: other,
        reportedPermissionMode: mode
      })
      expect(rig.sent('session/set_config_option')).toHaveLength(0)
      expect(store.getRecord(sessionId)?.lease.runtimeFence).toBe(currentFence)
    } finally {
      cleanup()
      resetStructuredAgentSessionStatusFeedsForTests()
      resetHostModelCatalogSnapshotsForTests()
      await rig.adapter.closeAll()
      setLocalRuntimeCapabilitiesForTests(null)
    }
  }
)

it('publishes accepted Codex fresh policy to desktop and phone without stale startup readback', async () => {
  const { host, store, root } = hostTestState()
  const answer = Promise.withResolvers<unknown>()
  const codex = fakeCodex({ 'turn/start': () => answer.promise })
  codex.routes['thread/start'] = () => ({
    thread: { id: CODEX_THREAD_ID },
    model: 'gpt-live',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'workspaceWrite' }
  })
  const settlements: Promise<void>[] = []
  const adapter = structuredAgentRuntimeRegistration('codex')!.createAdapter({
    deps: {
      ...host.deps,
      stateDirectory: root,
      hostId: 'local',
      resolveWorkspacePath: async () => root,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' as const }),
      resolveCodexCommand: () => ({ command: 'codex', prefixArgs: [] }),
      readCodexInstallation: async () => ({ version: '0.136.0' }),
      readProcessStartTime: async () => 1_700_000_000_000,
      openCodexConnection: codex.openConnection
    },
    store,
    journalDatabase: host.deps.journalDatabase,
    environment: createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({})
    }),
    host: () => host,
    followUps: { onDispatchSettledLate: () => {} },
    deliverLifecycle: (event) => {
      settlements.push(host.handleAdapterEvent(event))
    }
  })
  host.deps.adapter = adapter
  let sending: ReturnType<typeof adapter.dispatch> | undefined
  try {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY])
    expect(
      (
        await host.attach(
          CALLER,
          attachParams({
            providerHandle: undefined,
            options: { permissionMode: 'own' }
          })
        )
      ).ok
    ).toBe(true)
    await waitFor(() => expect(host.readStatusSummary(sessionId)?.hostExecutionPhase).toBe('ready'))
    const fence = store.getRecord(sessionId)!.lease.runtimeFence
    const child = host.collaboratorsForTests().sessions.get(sessionId)!.child!
    const { mount, write } = permissionConsumersFor(host, 'codex', fence)
    const views = mount()
    const descriptions = () =>
      views.map(
        (view) =>
          view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')?.description
      )
    await waitFor(() => expect(descriptions()).toEqual(['Approve for me', 'Approve for me']))
    const desktop = views[0]!
    await act(async () => {
      const applied = await desktop.result.current.setStructuredOption('permissionMode', 'ask')
      expect(
        write.mock.settledResults.at(-1)?.value,
        JSON.stringify(write.mock.settledResults.at(-1)?.value)
      ).toMatchObject({ ok: true })
      expect(applied).toBe(true)
    })
    const saved = structuredClone(store.getRecord(sessionId))
    const readCurrentOptions = adapter.readOptions!.bind(adapter, { sessionId, fence })
    expect((await readCurrentOptions()).current.reportedPermissionMode).toBe('auto')
    sending = adapter.dispatch({
      sessionId,
      clientMessageId: 'same-child-ask',
      body: USER_MESSAGE,
      fence,
      admitFreshInput: async (enqueue) => enqueue('ask', false)
    })
    const finished = sending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await waitFor(() =>
      expect(codex.connections[0]!.calls.some((call) => call.method === 'turn/start')).toBe(true)
    )
    codex.connections[0]!.handlers.onNotification?.('turn/started', {
      threadId: CODEX_THREAD_ID,
      turn: { id: 'applied-ask' }
    })
    expect(host.readStatusSummary(sessionId)?.runtimePermission).toEqual({ fence, mode: 'auto' })
    expect(descriptions()).toEqual(['Approve for me', 'Approve for me'])
    await act(async () => {
      answer.resolve({ turn: { id: 'applied-ask' } })
      expect(await finished).toMatchObject({ value: { state: 'admitted' } })
      await Promise.all(settlements)
    })
    await waitFor(() => expect(descriptions()).toEqual(['Ask for approval', 'Ask for approval']))
    expect((await readCurrentOptions()).current.reportedPermissionMode).toBe('ask')
    await host.drainStatusWrites()
    const updated = store.getRecord(sessionId)
    expect(updated).toEqual({ ...saved, lastTurn: updated?.lastTurn })
    expect(updated?.lastTurn).toEqual({ state: 'open', at: expect.any(Number), prompt: '' })
    expect((await host.readOptions(sessionId)).current).toMatchObject({
      permissionMode: 'ask',
      reportedPermissionMode: 'ask'
    })
    await act(async () => {
      await host.handleAdapterEvent({
        type: 'options-reported',
        sessionId,
        fence: fence - 1,
        acquisitionGeneration: 'retired-child',
        reportedOptions: { model: 'gpt-live', reportedPermissionMode: 'auto' }
      })
    })
    expect(host.readStatusSummary(sessionId)?.runtimePermission).toEqual({ fence, mode: 'ask' })
    expect(host.collaboratorsForTests().sessions.get(sessionId)!.child).toBe(child)
    expect(codex.connections).toHaveLength(1)
    const starts = codex.connections[0]!.calls.filter((call) => call.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.params).toMatchObject({
      clientUserMessageId: 'same-child-ask',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' }
    })
    views.forEach((view) => view.unmount())
  } finally {
    answer.resolve({ turn: { id: 'applied-ask' } })
    await sending?.catch(() => {})
    await Promise.all(settlements)
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    resetHostModelCatalogSnapshotsForTests()
    await host.close(sessionId, 'user-close')
    await adapter.closeAll()
    await Promise.all(settlements)
    setLocalRuntimeCapabilitiesForTests(null)
  }
})
