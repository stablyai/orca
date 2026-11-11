import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TerminalAttachmentLaunchResult } from '../../../../../../shared/terminal/pty/lifecycle/terminal-attachment-launch-result'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const fixture = vi.hoisted(() => ({ state: {} }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => fixture.state } }))
let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
const { runtimeCall, subscriptionSendBinary, latestSubscribePayload, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })
beforeEach(resetRemoteRuntimeTransport)
afterEach(() => vi.clearAllMocks())

it.each(['subscription', 'recovery'] as const)(
  'rejects predecessor %s facts while a successor connect owns the callback bundle',
  async (operation) => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    const predecessorResult = vi.fn()
    const successorResult = vi.fn()
    const launchResult: TerminalAttachmentLaunchResult = {
      ptyId: 'physical-1',
      incarnationId: 'incarnation-1',
      agentResumeRefused: 'chat-home',
      savedResumeDecision: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'C' },
        verdict: 'chat-home'
      }
    }
    let finishRecovery: (value: unknown) => void = () => {}
    const recoveryResult = new Promise((resolve) => {
      finishRecovery = resolve
    })
    let finishActivation: (value: unknown) => void = () => {}
    const activationResult = new Promise((resolve) => {
      finishActivation = resolve
    })
    try {
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onLaunchResult: predecessorResult }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const { streamId, terminal } = latestSubscribePayload()
      const defaultCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation((request: { method: string }) => {
        if (request.method === 'terminal.recoverPane') {
          return recoveryResult
        }
        if (request.method === 'session.tabs.activate') {
          return activationResult
        }
        return defaultCall?.(request)
      })
      if (operation === 'recovery') {
        subscriptionCallbacks?.onResponse({
          ok: true,
          result: { type: 'error', streamId, message: 'SSH_SESSION_EXPIRED: relay changed' }
        })
        await vi.waitFor(() =>
          expect(runtimeCall).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'terminal.recoverPane' })
          )
        )
      }
      const successor = transport.connect({
        url: '',
        callbacks: { onLaunchResult: successorResult }
      })
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'session.tabs.activate' })
        )
      )
      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'subscribed', streamId, terminal, launchResult }
      })
      finishRecovery({
        ok: true,
        result: { terminal: { handle: terminal, ...launchResult } }
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(predecessorResult).not.toHaveBeenCalled()
      expect(successorResult).not.toHaveBeenCalled()
      transport.disconnect()
      finishActivation({ ok: true, result: {} })
      await successor
    } finally {
      transport.disconnect()
      finishRecovery({ ok: true, result: {} })
      finishActivation({ ok: true, result: {} })
    }
  }
)
