import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

// Overlap stream opening with terminal.create and dedupe reveal viewport claims to avoid serial round trips.

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

describe('remote pane reveal round trips', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  async function createRevealTransport() {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    return createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
  }

  it('closes a warmed stream when the create fails and nothing subscribes', async () => {
    const unsubscribe = vi.fn()
    const defaultSubscribe = runtimeSubscribe.getMockImplementation()!
    runtimeSubscribe.mockImplementation(
      async (args: unknown, callbacks: MultiplexSubscriptionCallbacks) => ({
        ...(await defaultSubscribe(args, callbacks)),
        unsubscribe
      })
    )
    runtimeCall.mockRejectedValue(new Error('terminal create failed'))
    const transport = await createRevealTransport()

    await transport.connect({ url: '', callbacks: {} })
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
  })

  it('sends one claim when a reveal claims the same grid twice before the host answers', async () => {
    const transport = await createRevealTransport()
    await transport.connect({ url: '', cols: 120, rows: 40, callbacks: {} })
    const { streamId } = latestSubscribePayload()
    const framesOf = (opcode: TerminalStreamOpcode) =>
      subscriptionSendBinary.mock.calls.filter(
        ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode === opcode
      ).length

    // Visibility resume, then the layout observer one frame later.
    transport.claimViewport?.(120, 40)
    transport.resize(120, 40, { claim: true })
    expect(framesOf(TerminalStreamOpcode.ClaimViewport)).toBe(1)
    expect(framesOf(TerminalStreamOpcode.Resize)).toBe(1)

    // A different grid is new information and still goes out.
    transport.claimViewport?.(100, 40)
    expect(framesOf(TerminalStreamOpcode.ClaimViewport)).toBe(2)

    // Host fit/driver responses acknowledge our claim; they are not reasons to claim again.
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'fit-override-changed', streamId, mode: 'desktop-fit', cols: 159, rows: 69 }
    })
    for (const kind of ['idle', 'desktop'] as const) {
      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'driver-changed', streamId, driver: { kind } }
      })
    }
    transport.claimViewport?.(100, 40)
    expect(framesOf(TerminalStreamOpcode.ClaimViewport)).toBe(2)

    // A peer holding the pane, even at the same grid, re-arms the claim.
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'fit-override-changed',
        streamId,
        mode: 'remote-desktop-fit',
        cols: 100,
        rows: 40
      }
    })
    transport.claimViewport?.(100, 40)
    expect(framesOf(TerminalStreamOpcode.ClaimViewport)).toBe(3)
  })
})
