import { beforeEach, describe, expect, it, vi } from 'vitest'
import { warnRemoteTerminalInputDelivery } from './remote-terminal-input-delivery-warning'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

vi.mock('./remote-terminal-input-delivery-warning', () => ({
  warnRemoteTerminalInputDelivery: vi.fn()
}))

let callbacks: MultiplexSubscriptionCallbacks = null
let paneHandle = 'terminal-1'
const harness = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (next) => {
    callbacks = next
  },
  getResolvedPaneHandle: () => paneHandle,
  setResolvedPaneHandle: (next) => {
    paneHandle = next
  }
})

describe('legacy remote host input delivery warnings', () => {
  beforeEach(() => harness.resetRemoteRuntimeTransport())

  async function openLegacy() {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(harness.subscriptionSendBinary).toHaveBeenCalled())
    callbacks?.onResponse({
      ok: true,
      result: { type: 'subscribed', streamId: harness.latestSubscribePayload().streamId }
    })
    return transport
  }

  it.each(['accepted', 'unverifiable', 'timeout'] as const)(
    'uses host request/reply receipts and warns only for uncertainty (%s)',
    async (outcome) => {
      const transport = await openLegacy()
      try {
        const previous = harness.runtimeCall.getMockImplementation()
        harness.runtimeCall.mockImplementation((request: { method: string }) => {
          if (request.method !== 'terminal.send') {
            return previous?.(request)
          }
          if (outcome === 'timeout') {
            return Promise.reject(new Error('Remote request timed out'))
          }
          return Promise.resolve({
            ok: true,
            result: { send: { accepted: outcome === 'accepted', writeSettlement: { outcome } } }
          })
        })
        expect(transport.sendInput('a', 'driving')).toBe(true)
        await vi.waitFor(() =>
          expect(harness.runtimeCall).toHaveBeenCalledWith(
            expect.objectContaining({
              method: 'terminal.send',
              params: expect.objectContaining({ text: 'a', requireWriteSettlement: true })
            })
          )
        )
        if (outcome === 'accepted') {
          expect(warnRemoteTerminalInputDelivery).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() =>
            expect(warnRemoteTerminalInputDelivery).toHaveBeenCalledWith('env-1', 'terminal-1')
          )
        }
        expect(
          harness.runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.send')
        ).toHaveLength(1)
      } finally {
        transport.destroy?.()
      }
    }
  )
})
