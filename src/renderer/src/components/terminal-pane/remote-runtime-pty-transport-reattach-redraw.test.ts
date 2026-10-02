import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let callbacks: MultiplexSubscriptionCallbacks = null
let handle = 'terminal-1'
const mocks = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (next) => {
    callbacks = next
  },
  getResolvedPaneHandle: () => handle,
  setResolvedPaneHandle: (next) => {
    handle = next
  }
})

async function attachTransport(onError = vi.fn()) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    callbacks: { onError }
  })
  await vi.waitFor(() => expect(mocks.subscriptionSendBinary).toHaveBeenCalled())
  mocks.emitSnapshot(mocks.latestSubscribePayload().streamId, 'authoritative state')
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  mocks.runtimeCall.mockClear()
  mocks.subscriptionSendBinary.mockClear()
  return transport
}

describe('remote reattach viewport redraw', () => {
  beforeEach(() => mocks.resetRemoteRuntimeTransport())

  it('uses one optional-field RPC and clears a queued ordinary resize', async () => {
    const transport = await attachTransport()
    try {
      transport.resize(100, 30)
      expect(transport.resize(80, 24, { redraw: true })).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(mocks.runtimeCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: 'terminal.updateViewport',
          params: {
            terminal: 'terminal-1',
            client: { id: expect.any(String), type: 'desktop' },
            viewport: { cols: 80, rows: 24 },
            redraw: true
          }
        })
      )
      expect(mocks.subscriptionSendBinary).not.toHaveBeenCalled()
    } finally {
      transport.destroy?.()
    }
  })

  it('tolerates an older host that ignores redraw and returns the old reply', async () => {
    const onError = vi.fn()
    const transport = await attachTransport(onError)
    try {
      mocks.runtimeCall.mockResolvedValue({
        ok: true,
        result: { updated: true, applied: true, seq: 1 }
      })
      expect(transport.resize(80, 24, { redraw: true })).toBe(true)
      await Promise.resolve()
      expect(onError).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(true)
    } finally {
      transport.destroy?.()
    }
  })

  it('does not turn a best-effort redraw refusal into a terminal error', async () => {
    const onError = vi.fn()
    const transport = await attachTransport(onError)
    try {
      mocks.runtimeCall.mockResolvedValue({
        ok: false,
        error: { code: 'internal_error', message: 'offline' }
      })
      transport.resize(80, 24, { redraw: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onError).not.toHaveBeenCalled()
    } finally {
      transport.destroy?.()
    }
  })

  it.each([
    { cols: 10, rows: 4, viewport: { cols: 20, rows: 8 } },
    { cols: 500, rows: 300, viewport: { cols: 240, rows: 120 } }
  ])(
    'requests redraw at the host-clamped grid for $cols×$rows panes',
    async ({ cols, rows, viewport }) => {
      const transport = await attachTransport()
      try {
        transport.resize(cols, rows, { redraw: true })
        await vi.waitFor(() =>
          expect(mocks.runtimeCall).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              method: 'terminal.updateViewport',
              params: expect.objectContaining({ viewport, redraw: true })
            })
          )
        )
        expect(mocks.subscriptionSendBinary).not.toHaveBeenCalled()
      } finally {
        transport.destroy?.()
      }
    }
  )

  it('does not send redraw after detaching', async () => {
    const transport = await attachTransport()
    try {
      transport.detach?.()
      mocks.runtimeCall.mockClear()
      expect(transport.resize(80, 24, { redraw: true })).toBe(false)
      expect(mocks.runtimeCall).not.toHaveBeenCalled()
    } finally {
      transport.destroy?.()
    }
  })
})
