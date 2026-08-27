import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
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

  it('uses a strengthened sticky policy when an inventory retry starts', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-old'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
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
      runtimeCall.mockImplementation((args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return oldSendResponse
        }
        if (args.method === 'session.tabs.list') {
          hostListCalls += 1
          return Promise.reject(new Error('runtime reconnect in progress'))
        }
        return Promise.resolve({ ok: true, result: {} })
      })
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
      await vi.advanceTimersByTimeAsync(15_000)
      expect(transport.getRecoveryState?.().phase).toBe('backoff')

      resolveOldSend({
        ok: false,
        error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
      })
      await expect(pendingSend).resolves.toBe(false)
      const callsBeforeRetry = hostListCalls
      await vi.advanceTimersByTimeAsync(1_000)

      expect(hostListCalls).toBe(callsBeforeRetry)
      expect(subscribedTerminalHandles()).toEqual(['terminal-old'])
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-old')
      expect(transport.isConnected()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires replacement after repeated same-handle stream-end flaps', async () => {
    vi.useFakeTimers()
    try {
      resolvedPaneHandle = 'terminal-flapping'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1',
        onPtyExit
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-flapping',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'initial handle')
      runtimeCall.mockImplementation((args: { method: string }) =>
        args.method === 'session.tabs.list'
          ? Promise.resolve(readyHostSessionInventoryResponse('terminal-flapping'))
          : Promise.resolve({ ok: true, result: {} })
      )

      for (let cycle = 0; cycle < 2; cycle += 1) {
        const endedStreamId = latestSubscribePayload().streamId
        subscriptionCallbacks?.onResponse({
          ok: true,
          result: { type: 'end', streamId: endedStreamId, code: 0 }
        })
        await vi.advanceTimersByTimeAsync(16_000)
        expect(subscribedTerminalHandles()).toHaveLength(cycle + 2)
        expect(latestSubscribePayload().terminal).toBe('terminal-flapping')
        emitSnapshot(latestSubscribePayload().streamId, `same handle ${cycle + 1}`)
        expect(transport.isConnected()).toBe(true)
      }

      const condemnedStreamId = latestSubscribePayload().streamId
      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: condemnedStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(subscribedTerminalHandles()).toEqual([
        'terminal-flapping',
        'terminal-flapping',
        'terminal-flapping'
      ])
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-flapping')
      expect(transport.isConnected()).toBe(false)
      expect(onPtyExit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(44_001)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(subscribedTerminalHandles()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses prior ready evidence when the trailing inventory poll fails', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolvedPaneHandle = 'terminal-stable'
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-stable',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const oldStreamId = latestSubscribePayload().streamId
      emitSnapshot(oldStreamId, 'before trailing failure')
      let hostListCalls = 0
      runtimeCall.mockImplementation(
        async (args: { method: string; timeoutMs?: number }): Promise<unknown> => {
          if (args.method !== 'session.tabs.list') {
            return { ok: true, result: {} }
          }
          hostListCalls += 1
          if ((args.timeoutMs ?? 15_000) <= 1_000) {
            throw new Error('final inventory poll failed')
          }
          return readyHostSessionInventoryResponse('terminal-stable')
        }
      )

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: oldStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(hostListCalls).toBeGreaterThan(1)
      expect(subscribedTerminalHandles()).toEqual(['terminal-stable', 'terminal-stable'])
      expect(warn).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(latestSubscribePayload().streamId, 'ready evidence reused')
      expect(transport.isConnected()).toBe(true)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not carry a stale-handle requirement onto the replacement stream', async () => {
    vi.useFakeTimers()
    try {
      let rejectedReplacement = false
      subscriptionSendBinary.mockImplementation((bytes: Uint8Array<ArrayBufferLike>) => {
        const frame = decodeTerminalStreamFrame(bytes)
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        if (payload?.terminal === 'terminal-replacement' && !rejectedReplacement) {
          rejectedReplacement = true
          throw new Error('Remote runtime connection closed.')
        }
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('hub-env', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1',
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-stale'
      transport.attach({
        existingPtyId: 'remote:hub-env@@terminal-stale',
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const staleStreamId = latestSubscribePayload().streamId
      emitSnapshot(staleStreamId, 'before stale handle')

      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method !== 'session.tabs.activate' && args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        return {
          ok: true,
          result: {
            worktree: 'wt-1',
            publicationEpoch: 'epoch-replacement',
            snapshotVersion: 2,
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
                terminal: 'terminal-replacement'
              }
            ]
          }
        }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: staleStreamId,
          message: 'terminal_handle_stale'
        }
      })
      await vi.waitFor(() => expect(rejectedReplacement).toBe(true))
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(runtimeSubscribe.mock.calls.length).toBeGreaterThanOrEqual(2))

      const subscribedTerminals = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .flatMap((frame) => {
          if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
            return []
          }
          const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
          return payload ? [payload.terminal] : []
        })
      expect(subscribedTerminals).toEqual([
        'terminal-stale',
        'terminal-replacement',
        'terminal-replacement'
      ])
      expect(onPtyRebind).toHaveBeenCalledOnce()
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-replacement' })
      )
      emitSnapshot(latestSubscribePayload().streamId, 'replacement reattached')
      expect(transport.isConnected()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces concurrent stale errors for the handle that was replaced', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-stale'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    let resolveHostList: (response: unknown) => void = () => {}
    const hostListResponse = new Promise((resolve) => {
      resolveHostList = resolve
    })
    let hostListCalls = 0
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: false,
          error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
        })
      }
      if (args.method === 'session.tabs.list') {
        hostListCalls += 1
        return hostListResponse
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    const sendInputAccepted = transport.sendInputAccepted
    if (!sendInputAccepted) {
      throw new Error('Expected acknowledged remote terminal input')
    }
    const sends = Promise.all([sendInputAccepted('first'), sendInputAccepted('second')])
    await vi.waitFor(() => expect(hostListCalls).toBe(1))
    await expect(sends).resolves.toEqual([false, false])

    resolveHostList({
      ok: true,
      result: {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: 'tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1::pane:1',
            parentTabId: 'tab-1',
            leafId: 'pane:1',
            title: 'Claude Code',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-reconnected'
          }
        ]
      }
    })

    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-reconnected' })
    )
    await Promise.resolve()

    // Why: the second stale response belonged to terminal-stale. Replaying it
    // against the replacement would add another polling loop and retire it.
    expect(hostListCalls).toBe(1)
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-reconnected')
    expect(transport.isConnected()).toBe(false)
    emitSnapshot(latestSubscribePayload().streamId, 'reattached')
    expect(transport.isConnected()).toBe(true)
  })
})
