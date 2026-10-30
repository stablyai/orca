import { expect, it, vi } from 'vitest'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import { createPane, createManager, LEAF_1 } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { installTerminalTestGlobals } from './pty-connection-test-environment'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import type { StoreState } from './pty-connection-test-store-state'
import type * as RemotePtyTransport from './remote-runtime-pty-transport'
import type { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'

export function registerPersistedResidentAuthorityTests(fixture: {
  getState: () => StoreState
  enableRemote: () => void
  setTransportFactory: (factory: typeof createRemoteRuntimePtyTransport) => void
}): void {
  it.each(['shell', 'question', 'working-interrupt', 'pending-completion'] as const)(
    'folds real persisted paired input into established S0 execution: %s',
    async (scenario) => {
      const subscriptionState: { callbacks: MultiplexSubscriptionCallbacks } = { callbacks: null }
      let resolvedHandle = 'terminal-1'
      const wire = createRemoteRuntimeTransportMocks({
        getCallbacks: () => subscriptionState.callbacks,
        setCallbacks: (value) => {
          subscriptionState.callbacks = value
        },
        getResolvedPaneHandle: () => resolvedHandle,
        setResolvedPaneHandle: (value) => {
          resolvedHandle = value
        }
      })
      wire.resetRemoteRuntimeTransport()
      const runtimeEnvironments = window.api.runtimeEnvironments
      await installTerminalTestGlobals()
      Object.assign(window.api, { runtimeEnvironments })
      fixture.enableRemote()
      const state = fixture.getState()
      const ptyId = 'remote:env-1@@terminal-1'
      const tabId = 'web-terminal-host-tab-1'
      const paneKey = makePaneKey(tabId, LEAF_1)
      state.tabsByWorktree['wt-1'][0].id = tabId
      state.terminalLayoutsByTabId[tabId] = state.terminalLayoutsByTabId['tab-1']
      state.tabsByWorktree['wt-1'][0].ptyId = ptyId
      state.ptyIdsByTabId[tabId] = [ptyId]
      // The saved tab identifies a reattach, but no physical pane binding is known yet.
      state.terminalLayoutsByTabId[tabId].ptyIdsByLeafId = {}
      Object.assign(state, { isPtyShutdownPending: () => false })
      const { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } =
        await import('../../../../shared/protocol-version')
      const status = {
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY, 'terminal-side-effect-state.v1']
      }
      state.runtimeStatusByEnvironmentId.set('env-1', { status, checkedAt: 1_000 })
      const deps = buildPaneConnectionDeps(fixture.getState, {
        tabId,
        mountFollowsTerminalPark: true
      })
      Object.assign(state, {
        setCacheTimerStartedAt: deps.setCacheTimerStartedAt,
        setRuntimePaneTitle: deps.setRuntimePaneTitle,
        updateTabTitle: deps.updateTabTitle
      })
      if (scenario === 'question' || scenario === 'working-interrupt') {
        state.agentStatusByPaneKey[paneKey] = {
          paneKey,
          state: scenario === 'question' ? 'waiting' : 'working',
          agentType: scenario === 'question' ? 'claude' : 'gemini',
          prompt: 'original turn',
          ...(scenario === 'question' ? { toolName: 'AskUserQuestion' } : {}),
          updatedAt: Date.now(),
          stateStartedAt: Date.now() - 100,
          stateHistory: []
        }
      }
      vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
      Object.assign(window.api.agentStatus, {
        inferQuestionAnswered: vi.fn().mockResolvedValue(true)
      })
      const resolution = createDeferred<void>()
      const receipt = createDeferred<void>()
      const originalCall = wire.runtimeCall.getMockImplementation()
      wire.runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
        if (request.method === 'status.get') {
          return { ok: true, result: status }
        }
        if (request.method === 'terminal.resolvePane') {
          await resolution.promise
        }
        if (request.method === 'terminal.send') {
          await receipt.promise
          return { ok: true, result: { send: { accepted: true } } }
        }
        return originalCall?.(request)
      })
      const real = await vi.importActual<typeof RemotePtyTransport>(
        './remote-runtime-pty-transport'
      )
      const transportFactory = vi.fn(
        (...args: Parameters<typeof real.createRemoteRuntimePtyTransport>) => {
          const transport = real.createRemoteRuntimePtyTransport(...args)
          const connect = transport.connect.bind(transport)
          const attach = transport.attach.bind(transport)
          transport.connect = vi.fn(connect)
          transport.attach = vi.fn(attach)
          return transport
        }
      )
      fixture.setTransportFactory(transportFactory)
      const policyModule = await import('./terminal-resident-policy')
      const policyFactory = vi.spyOn(policyModule, 'createTerminalResidentPolicy')
      const handler = await import('./terminal-side-effect-facts-handler')
      const source = new TerminalSnapshotState()
      if (scenario === 'pending-completion') {
        source.record({ kind: 'agent-working' })
      }
      const deliver = () =>
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId,
          paneKey,
          worktreeId: 'wt-1',
          tabId,
          seq: source.state.revision,
          facts: [],
          terminalState: {
            runtimeId: 'runtime-1',
            incarnationId: 'incarnation-1',
            snapshot: source.snapshot()
          }
        })
      deliver()
      const resident = handler.getTerminalSemanticResident(ptyId)
      if (!resident) {
        throw new Error('Real no-view S0 did not establish execution B')
      }
      const policy = resident.policy
      const acceptedInput = vi.spyOn(policy, 'acceptInput')
      const originalCursor = Object.getOwnPropertyDescriptor(resident, 'consumption')?.value
      const originalParser = Object.getOwnPropertyDescriptor(policy.legacySource, 'bytes')?.value
      const controllers = [
        policy.input,
        policy.completion,
        policy.notification,
        policy.legacySource
      ]
      expect(policyFactory).toHaveBeenCalledOnce()
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      let signalUserInput: (() => void) | undefined
      Object.assign(pane.terminal, {
        _core: {
          coreService: {
            onUserInput: (listener: () => void) => {
              signalUserInput = listener
              return {
                dispose: () => {
                  signalUserInput = undefined
                }
              }
            }
          }
        }
      })
      const connection = connectPanePty(pane as never, createManager(1) as never, deps as never)
      const transport = transportFactory.mock.results[0]?.value
      if (!transport) {
        throw new Error('Pane did not construct the real paired transport')
      }
      const acceptedWrite = vi.spyOn(transport, 'sendInputAccepted')
      try {
        await vi.waitFor(() =>
          expect(wire.runtimeCall).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'terminal.resolvePane' })
          )
        )
        expect(transport.getPtyId()).toBeNull()
        const input =
          scenario === 'working-interrupt' ? '\x03' : scenario === 'question' ? '\r' : 'answer\r'
        expect(signalUserInput).toBeTypeOf('function')
        signalUserInput?.()
        sendTerminalInputThroughPane(pane, input)
        expect(wire.inputFrameTexts()).toEqual([])
        expect(
          wire.runtimeCall.mock.calls.filter(([call]) => call.method === 'terminal.send')
        ).toEqual([])
        expect(acceptedInput).not.toHaveBeenCalled()
        source.record({ kind: 'bell' })
        if (scenario === 'pending-completion') {
          source.record({ kind: 'agent-idle', title: 'Codex done', status: 'idle' })
        }
        deliver()
        const pendingCompletion = policy.notification.hasPendingAgentTaskCompleteNotification()
        if (scenario === 'pending-completion') {
          expect(pendingCompletion).toBe(true)
        }
        console.info('retention-trace', scenario, {
          connect: vi.mocked(transport.connect).mock.calls.map(([options]) => options.sessionId),
          attach: vi.mocked(transport.attach).mock.calls.map(([options]) => options.existingPtyId),
          factory: policyFactory.mock.calls.length
        })
        resolution.resolve()
        await vi.waitFor(() => expect(wire.latestSubscribePayload()).toBeDefined())
        const subscription = wire.latestSubscribePayload()
        expect(subscription.terminal).toBe('terminal-1')
        subscriptionState.callbacks?.onResponse({
          ok: true,
          result: { type: 'subscribed', streamId: subscription.streamId }
        })
        wire.emitSnapshot(subscription.streamId, 'prompt$ ')
        await vi.waitFor(() => expect(transport.getPtyId()).toBe(ptyId))
        if (scenario === 'working-interrupt') {
          await vi.waitFor(() =>
            expect(wire.runtimeCall).toHaveBeenCalledWith(
              expect.objectContaining({
                selector: 'env-1',
                method: 'terminal.send',
                params: expect.objectContaining({ terminal: 'terminal-1', text: input })
              })
            )
          )
          connection.dispose()
          expect(resident.isLive).toBe(true)
          expect(handler.getTerminalSemanticResident(ptyId)).toBe(resident)
          receipt.resolve()
          await expect(acceptedWrite.mock.results[0]?.value).resolves.toBe(true)
          console.info('accepted-receipt', {
            target: ptyId,
            accepted: await acceptedWrite.mock.results[0]?.value
          })
          await flushAsyncTicks(30)
          expect.soft(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith(
            expect.objectContaining({
              paneKey,
              intent: 'ctrl-c',
              baselinePrompt: 'original turn',
              baselineAgentType: 'gemini'
            })
          )
        } else {
          await vi.waitFor(() => expect(wire.inputFrameTexts()).toEqual([input]))
        }
        if (scenario === 'working-interrupt') {
          expect.soft(acceptedInput).toHaveBeenCalledExactlyOnceWith(input, 'ctrl-c')
        } else {
          expect.soft(acceptedInput).toHaveBeenCalledExactlyOnceWith(input)
        }
        if (scenario === 'question') {
          expect
            .soft(window.api.agentStatus.inferQuestionAnswered)
            .toHaveBeenCalledWith(expect.objectContaining({ paneKey }))
        }
        expect.soft(policyFactory).toHaveBeenCalledOnce()
        expect(handler.getTerminalSemanticResident(ptyId)).toBe(resident)
        expect([policy.input, policy.completion, policy.notification, policy.legacySource]).toEqual(
          controllers
        )
        expect(Object.getOwnPropertyDescriptor(resident, 'consumption')?.value).toBe(originalCursor)
        expect(Object.getOwnPropertyDescriptor(policy.legacySource, 'bytes')?.value).toBe(
          originalParser
        )
        connection.dispose()
        expect(resident.isLive).toBe(true)
        if (scenario === 'pending-completion') {
          expect(policy.notification.hasPendingAgentTaskCompleteNotification()).toBe(true)
          await new Promise((resolve) =>
            setTimeout(resolve, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
          )
          const completions = vi
            .mocked(window.api.notifications.dispatch)
            .mock.calls.filter(([request]) => request.source === 'agent-task-complete')
          expect(completions).toHaveLength(1)
          deliver()
          await new Promise((resolve) =>
            setTimeout(resolve, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
          )
          expect(
            vi
              .mocked(window.api.notifications.dispatch)
              .mock.calls.filter(([request]) => request.source === 'agent-task-complete')
          ).toHaveLength(1)
        }
      } finally {
        resolution.resolve()
        receipt.resolve()
        connection.dispose()
        transport.destroy?.()
        policyFactory.mockRestore()
      }
    }
  )
}
