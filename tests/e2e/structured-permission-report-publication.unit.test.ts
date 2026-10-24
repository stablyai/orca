// @vitest-environment happy-dom
import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
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
import type { ClaudeStructuredSessionEvent } from '../../src/main/claude/claude-structured-session-state'
import { structuredClaudeLifecycleEvent } from '../../src/main/runtime/structured-claude-runtime-adapter'
import {
  hostTestState,
  attachParams,
  CALLER
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as sessionId } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../src/shared/agent-session-permission-modes-capability'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

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
      const read = vi.fn(async (method: string) => {
        if (method !== 'agentSession.options') {
          return new Promise<never>(() => {})
        }
        return host.readOptions(sessionId)
      })
      transport.call.mockImplementation((_target, method) => read(method))
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
      const target = { kind: 'local' } as const
      const common = { agent: 'claude' as const, sessionId, fence }
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
            mutate: vi.fn(async () => null)
          }),
        () =>
          useMobileStructuredAgentOptions({
            ...common,
            client,
            enabled: true,
            optionStamp: 'model|own',
            hostSupport: {
              permissionModes: true,
              permissionOwn: true,
              statusFeed: true,
              coherentModelCatalog: false
            },
            mutate: vi.fn(async () => ({ status: 'rejected' as const }))
          })
      ]
      const views = hooks.flatMap((useOptions) =>
        Array.from({ length: count }, () =>
          renderHook(() => ({ optionSnapshot: useOptions().optionSnapshot }))
        )
      )
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
      await act(async () => {
        subscriptions.forEach((dispose) => dispose())
      })
      expect(descriptions()).toEqual(Array(count * 2).fill('Claude settings'))
    } finally {
      cleanup()
      resetStructuredAgentSessionStatusFeedsForTests()
      resetHostModelCatalogSnapshotsForTests()
      await adapter.closeAll()
      setLocalRuntimeCapabilitiesForTests(null)
    }
  }
)
