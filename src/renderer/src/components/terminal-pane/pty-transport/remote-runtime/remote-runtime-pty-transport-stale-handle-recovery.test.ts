import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse
} from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

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
    const pendingSend = sendInputAccepted('sent-before-rebind', 'driving')
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
      const pendingSend = sendInputAccepted('sent-before-stream-end', 'driving')
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

      const handleEvents =
        await import('../../../../runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
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
