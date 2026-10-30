import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
  inputFrameTexts,
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

describe('remote runtime PTY stream end verdict', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('recovers a legacy bare end without reporting process exit', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
    const firstStreamId = latestSubscribePayload().streamId
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: firstStreamId }
    })

    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    )
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    transport.destroy?.()
  })

  it('retires the tab after an owning-host exit verdict', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId, verdict: 'exited' }
    })

    expect(onExit).toHaveBeenCalledWith(0)
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1')
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
  })
  it.each([new Error('first exit effect failed'), null, undefined])(
    'preserves the literal first reliable-end throw %s through independent captured cleanup',
    async (firstFailure) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { getRemoteRuntimeTerminalMultiplexer } =
        await import('../../runtime/remote-runtime-terminal-multiplexer')
      const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
      const subscribe = multiplexer.subscribeTerminal.bind(multiplexer)
      const closed = vi.fn()
      const interception = vi
        .spyOn(multiplexer, 'subscribeTerminal')
        .mockImplementation(async (args) => {
          const stream = await subscribe(args)
          const close = stream.close
          stream.close = () => {
            close()
            closed()
            throw new Error('captured close failed')
          }
          return stream
        })
      const onExit = vi.fn(() => {
        throw firstFailure
      })
      const onDisconnect = vi.fn()
      const onPtyExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1', onPtyExit })
      try {
        await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
        emitSnapshot(latestSubscribePayload().streamId, 'live A')
        const original = transport.getInputSource?.()
        let failed = false
        let failure: unknown
        try {
          subscriptionCallbacks?.onResponse({
            ok: true,
            result: {
              type: 'end',
              streamId: latestSubscribePayload().streamId,
              verdict: 'exited'
            }
          })
        } catch (error) {
          failed = true
          failure = error
        }
        expect(failed).toBe(true)
        expect(failure).toBe(firstFailure)
        expect(onExit).toHaveBeenCalledOnce()
        expect(onDisconnect).toHaveBeenCalledOnce()
        expect(onPtyExit.mock.calls).toEqual([['remote:env-1@@terminal-1']])
        expect(closed).toHaveBeenCalledOnce()
        expect(original?.isCurrent()).toBe(false)
        expect(transport.getPtyId()).toBeNull()
        expect(transport.sendInput('refused-after-end', 'driving')).toBe(false)
        expect(inputFrameTexts()).toEqual([])
        expect(transport.getRecoveryState?.().phase).toBe('ended')
      } finally {
        interception.mockRestore()
        transport.destroy?.()
      }
    }
  )

  it.each(['body-undefined', 'exit-overrides', 'close-overrides', 'close-undefined'] as const)(
    'preserves viewer completion precedence for %s after captured source departure',
    async (site) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { getRemoteRuntimeTerminalMultiplexer } =
        await import('../../runtime/remote-runtime-terminal-multiplexer')
      const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
      const subscribe = multiplexer.subscribeTerminal.bind(multiplexer)
      const order: string[] = []
      const disconnectFailure = site === 'body-undefined' ? undefined : new Error('disconnect')
      const exitFailure = new Error('exit')
      const closeFailure = site === 'close-undefined' ? undefined : new Error('close')
      const interception = vi
        .spyOn(multiplexer, 'subscribeTerminal')
        .mockImplementation(async (args) => {
          const stream = await subscribe(args)
          const close = stream.close
          stream.close = () => {
            close()
            order.push('close')
            if (site === 'close-overrides' || site === 'close-undefined') {
              throw closeFailure
            }
          }
          return stream
        })
      const onDisconnect = vi.fn(() => {
        order.push('disconnect')
        throw disconnectFailure
      })
      const onPtyExit = vi.fn(() => {
        order.push('exit')
        if (site === 'exit-overrides') {
          throw exitFailure
        }
      })
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1', onPtyExit })
      try {
        await transport.connect({ url: '', callbacks: { onDisconnect } })
        emitSnapshot(latestSubscribePayload().streamId, 'live A')
        const original = transport.getInputSource?.()
        expect(original?.isCurrent()).toBe(true)
        let failed = false
        let failure: unknown
        try {
          transport.disconnect()
        } catch (error) {
          failed = true
          failure = error
        }
        expect(failed).toBe(true)
        expect(failure).toBe(
          site === 'exit-overrides'
            ? exitFailure
            : site === 'body-undefined'
              ? disconnectFailure
              : closeFailure
        )
        expect(order).toEqual(['disconnect', 'exit', 'close'])
        expect(onDisconnect).toHaveBeenCalledOnce()
        expect(onPtyExit.mock.calls).toEqual([['remote:env-1@@terminal-1', -1]])
        expect(original?.isCurrent()).toBe(false)
        expect(transport.getPtyId()).toBeNull()
        expect(transport.sendInput('refused-after-departure', 'driving')).toBe(false)
        expect(inputFrameTexts()).toEqual([])
      } finally {
        interception.mockRestore()
        transport.destroy?.()
      }
    }
  )

  it.each(['viewer-undefined', 'tail-undefined', 'tail-error'] as const)(
    'preserves destroy viewer/tail priority for %s and finishes captured cleanup',
    async (site) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { getRemoteRuntimeTerminalMultiplexer } =
        await import('../../runtime/remote-runtime-terminal-multiplexer')
      const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
      const subscribe = multiplexer.subscribeTerminal.bind(multiplexer)
      const closed = vi.fn()
      const interception = vi
        .spyOn(multiplexer, 'subscribeTerminal')
        .mockImplementation(async (args) => {
          const stream = await subscribe(args)
          const close = stream.close
          stream.close = () => {
            close()
            closed()
          }
          return stream
        })
      const viewerFailure = site === 'viewer-undefined' ? undefined : new Error('viewer')
      const tailFailure = site === 'tail-undefined' ? undefined : new Error('tail')
      let disposedEmissions = 0
      const onRecoveryStateChange = vi.fn((state: PtyTransportRecoveryState) => {
        if (state.phase === 'disposed') {
          disposedEmissions += 1
          if (disposedEmissions === 2 && site !== 'viewer-undefined') {
            throw tailFailure
          }
        }
      })
      const onDisconnect = vi.fn(() => {
        throw viewerFailure
      })
      const onPtyExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1', onPtyExit })
      try {
        await transport.connect({ url: '', callbacks: { onDisconnect, onRecoveryStateChange } })
        emitSnapshot(latestSubscribePayload().streamId, 'live A')
        const source = transport.getInputSource?.()
        expect(source?.isCurrent()).toBe(true)
        let failed = false
        let failure: unknown
        try {
          transport.destroy?.()
        } catch (error) {
          failed = true
          failure = error
        }
        expect(failed).toBe(true)
        expect(failure).toBe(site === 'viewer-undefined' ? viewerFailure : tailFailure)
        expect(disposedEmissions).toBe(2)
        expect(onDisconnect).toHaveBeenCalledOnce()
        expect(onPtyExit).toHaveBeenCalledOnce()
        expect(closed).toHaveBeenCalledOnce()
        expect(source?.isCurrent()).toBe(false)
        expect(transport.getRecoveryState?.().phase).toBe('disposed')
        expect(transport.getPtyId()).toBeNull()
        expect(transport.sendInput('after-destroy', 'driving')).toBe(false)
        expect(inputFrameTexts()).toEqual([])
        const events = await import('../../runtime/web-session-terminal-handle-events')
        expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      } finally {
        interception.mockRestore()
      }
    }
  )
})
