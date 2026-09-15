import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
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

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('caps unavailable host inventory at two recovery windows', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-stable'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('hub-env', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:hub-env@@terminal-stable',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const oldStreamId = latestSubscribePayload().streamId
      emitSnapshot(oldStreamId, 'before inventory outage')

      let hostListCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.list') {
          hostListCalls += 1
          throw new Error('runtime reconnect in progress')
        }
        return { ok: true, result: {} }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: oldStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(32_000)

      const callsAfterTwoWindows = hostListCalls
      expect(callsAfterTwoWindows).toBeGreaterThan(25)
      expect(callsAfterTwoWindows).toBeLessThan(40)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(hostListCalls).toBe(callsAfterTwoWindows)
      expect(transport.getRecoveryState?.().phase).toBe('recovering')

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(subscribedTerminalHandles()).toEqual(['terminal-stable'])
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reattaches from prior ready evidence when the trailing inventory poll fails', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-stable'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('hub-env', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1',
        onPtyExit
      })

      transport.attach({
        existingPtyId: 'remote:hub-env@@terminal-stable',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const oldStreamId = latestSubscribePayload().streamId
      emitSnapshot(oldStreamId, 'before trailing inventory failure')

      let hostListCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        hostListCalls += 1
        if (hostListCalls === 1) {
          return readyHostSessionInventoryResponse('terminal-stable')
        }
        throw new Error('final inventory poll failed')
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: oldStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(hostListCalls).toBeGreaterThan(1)
      expect(hostListCalls).toBeLessThan(25)
      expect(subscribedTerminalHandles()).toEqual(['terminal-stable', 'terminal-stable'])
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(latestSubscribePayload().streamId, 'reattached from ready evidence')
      expect(transport.isConnected()).toBe(true)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('strengthens repeated same-handle end recovery until it disconnects', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-flapping'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('hub-env', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:hub-env@@terminal-flapping',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      runtimeCall.mockImplementation(async (args: { method: string }) =>
        args.method === 'session.tabs.list'
          ? readyHostSessionInventoryResponse('terminal-flapping')
          : { ok: true, result: {} }
      )
      emitSnapshot(latestSubscribePayload().streamId, 'initial stream')

      for (let cycle = 0; cycle < 2; cycle += 1) {
        const endingStreamId = latestSubscribePayload().streamId
        subscriptionCallbacks?.onResponse({
          ok: true,
          result: { type: 'end', streamId: endingStreamId, code: 0 }
        })
        await vi.advanceTimersByTimeAsync(16_000)
        expect(subscribedTerminalHandles()).toHaveLength(cycle + 2)
        emitSnapshot(latestSubscribePayload().streamId, `same handle cycle ${cycle}`)
        expect(transport.isConnected()).toBe(true)
      }

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: latestSubscribePayload().streamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(subscribedTerminalHandles()).toEqual([
        'terminal-flapping',
        'terminal-flapping',
        'terminal-flapping'
      ])
      expect(transport.isConnected()).toBe(false)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a delayed stale send after the pane has rebound to a healthy handle', async () => {
    resolvedPaneHandle = 'terminal-old'
    let resolveOldSend: (response: unknown) => void = () => {}
    const oldSendResponse = new Promise((resolve) => {
      resolveOldSend = resolve
    })
    let hostListCalls = 0
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    emitSnapshot(oldStreamId, 'old handle')
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.send') {
        return oldSendResponse
      }
      if (args.method === 'session.tabs.list') {
        hostListCalls += 1
        return Promise.resolve(readyHostSessionInventoryResponse('terminal-new'))
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const sendInputAccepted = transport.sendInputAccepted
    if (!sendInputAccepted) {
      throw new Error('Expected acknowledged remote terminal input')
    }
    const pendingSend = sendInputAccepted('sent-before-rebind')
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.send' }))
    )

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId: oldStreamId, message: 'terminal_handle_stale' }
    })
    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
    )
    emitSnapshot(latestSubscribePayload().streamId, 'new handle')
    expect(transport.isConnected()).toBe(true)

    resolveOldSend({
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
    })
    await expect(pendingSend).resolves.toBe(false)

    expect(subscribedTerminalHandles()).toEqual(['terminal-old', 'terminal-new'])
    expect(hostListCalls).toBe(1)
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)
  })

  it('honors a sticky replacement requirement during non-web pane resolution', async () => {
    resolvedPaneHandle = 'terminal-old'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'old handle')

    let resolveOldSend: (response: unknown) => void = () => {}
    const oldSendResponse = new Promise((resolve) => {
      resolveOldSend = resolve
    })
    let resolvePane: (response: unknown) => void = () => {}
    const paneResponse = new Promise((resolve) => {
      resolvePane = resolve
    })
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.send') {
        return oldSendResponse
      }
      if (args.method === 'terminal.resolvePane') {
        return paneResponse
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const sendInputAccepted = transport.sendInputAccepted
    if (!sendInputAccepted) {
      throw new Error('Expected acknowledged remote terminal input')
    }
    const pendingSend = sendInputAccepted('sent-before-close')
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.send' }))
    )

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.resolvePane' })
      )
    )
    resolveOldSend({
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
    })
    await expect(pendingSend).resolves.toBe(false)
    resolvePane({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-old',
          tabId: 'tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1'
        }
      }
    })

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledOnce())
    expect(subscribedTerminalHandles()).toEqual(['terminal-old'])
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-old', -1)
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('does not subscribe a same handle condemned after its inventory wait returns', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-old'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1',
        onPtyRebind
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-old',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const oldStreamId = latestSubscribePayload().streamId
      emitSnapshot(oldStreamId, 'old handle')

      let resolveOldSend: (response: unknown) => void = () => {}
      const oldSendResponse = new Promise((resolve) => {
        resolveOldSend = resolve
      })
      let hostListCalls = 0
      runtimeCall.mockImplementation(
        (args: { method: string; timeoutMs?: number }): Promise<unknown> => {
          if (args.method === 'terminal.send') {
            return oldSendResponse
          }
          if (args.method !== 'session.tabs.list') {
            return Promise.resolve({ ok: true, result: {} })
          }
          hostListCalls += 1
          const response = readyHostSessionInventoryResponse('terminal-old')
          if ((args.timeoutMs ?? 15_000) > 1_000) {
            return Promise.resolve(response)
          }
          return new Promise((resolve) => {
            setTimeout(() => {
              // Why: settle the stale send between the inner wait and its caller's continuation.
              queueMicrotask(() =>
                queueMicrotask(() =>
                  resolveOldSend({
                    ok: false,
                    error: {
                      code: 'terminal_handle_stale',
                      message: 'terminal_handle_stale'
                    }
                  })
                )
              )
              resolve(response)
            }, args.timeoutMs)
          })
        }
      )
      const sendInputAccepted = transport.sendInputAccepted
      if (!sendInputAccepted) {
        throw new Error('Expected acknowledged remote terminal input')
      }
      const pendingSend = sendInputAccepted('sent-before-stream-end')
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'terminal.send' })
        )
      )

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: oldStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)
      await expect(pendingSend).resolves.toBe(false)

      expect(hostListCalls).toBeGreaterThan(1)
      expect(subscribedTerminalHandles()).toEqual(['terminal-old'])
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-old')
      expect(transport.isConnected()).toBe(false)

      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-replacement',
          snapshotVersion: 3,
          activeGroupId: null,
          activeTabId: 'host-tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab-1::pane:1',
              parentTabId: 'host-tab-1',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: true,
              status: 'ready',
              terminal: 'terminal-new'
            }
          ]
        },
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
      )
      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-new',
        'remote:env-1@@terminal-old'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
