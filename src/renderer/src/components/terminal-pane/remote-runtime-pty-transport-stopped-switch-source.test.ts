import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import type { StoppedSwitchSourceFact } from '../../../../shared/stopped-switch-source'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR } from '../../../../shared/terminal-multiplex-flow-control'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

// A paired client's pane whose process a switch stopped and kept: main's fact on the host row ends
// recovery for that exact process instead of reattaching to it.

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      throw new Error('The transport takes the fact from host rows, never from the app store')
    }
  }
}))

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
let hostFact: StoppedSwitchSourceFact | undefined

const {
  runtimeCall,
  runtimeSubscribe,
  latestSubscribePayload,
  emitSnapshot,
  subscribeFrameCount,
  subscriptionSendBinary,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Main's listing reply with the fact on every terminal row while the host holds one. */
function withHostFact(reply: unknown): unknown {
  if (!hostFact || !isRecord(reply) || !isRecord(reply.result)) {
    return reply
  }
  const result = reply.result
  const tabs = Array.isArray(result.tabs)
    ? result.tabs.map((tab: unknown) =>
        isRecord(tab) ? { ...tab, stoppedSwitchSource: hostFact } : tab
      )
    : result.tabs
  return { ...reply, result: { ...result, tabs } }
}

function stampHostRows(): void {
  const harnessCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    if (request.method === 'session.tabs.list') {
      return withHostFact(readyHostSessionInventoryResponse('terminal-1'))
    }
    const reply: unknown = await harnessCall?.(request)
    return request.method === 'session.tabs.activate' ? withHostFact(reply) : reply
  })
}

async function attachedMirror() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onPtyExit = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1',
    onPtyExit
  })
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: 100,
    rows: 30,
    callbacks: {}
  })
  await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
  const endStream = (verdict?: 'exited' | 'unverifiable'): void =>
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: latestSubscribePayload().streamId, verdict }
    })
  const answerStream = (result: Record<string, unknown>): void =>
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { ...result, streamId: latestSubscribePayload().streamId }
    })
  return { transport, onPtyExit, endStream, answerStream }
}

function hostFrame(fact?: StoppedSwitchSourceFact): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-2',
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
        terminal: 'terminal-1',
        ...(fact ? { stoppedSwitchSource: fact } : {})
      }
    ]
  }
}

describe.each(['claude', 'codex'] as const)(
  'a %s pane a switch stopped, on a paired client',
  (agent) => {
    const fact: StoppedSwitchSourceFact = {
      ptyId: 'host-pty-1',
      incarnationId: 'incarnation-1',
      agent,
      providerSessionId: `${agent}-conversation`
    }

    beforeEach(() => {
      resetRemoteRuntimeTransport()
      hostFact = undefined
      stampHostRows()
    })

    it('ends as stopped when the host row names the ended process', async () => {
      const { transport, onPtyExit, endStream } = await attachedMirror()
      hostFact = fact

      endStream('exited')

      await vi.waitFor(() =>
        expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', undefined, {
          stoppedSwitchSource: fact
        })
      )
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
      transport.destroy?.()
    })

    it('takes the fact from a frame that arrives while it waits', async () => {
      const { queueAcceptedWebSessionTerminalSnapshot } =
        await import('@/runtime/web-session-terminal-handle-events')
      // The host keeps the same handle published while the switch settles: recovery waits for it.
      const { transport, onPtyExit, endStream } = await attachedMirror()
      runtimeCall.mockImplementation(async () => new Promise(() => {}))
      endStream('exited')
      await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalled())

      queueAcceptedWebSessionTerminalSnapshot(hostFrame(fact), 'env-1')

      await vi.waitFor(() =>
        expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', undefined, {
          stoppedSwitchSource: fact
        })
      )
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
      transport.destroy?.()
    })

    it('takes the fact from a frame that lands during a reattach backoff', async () => {
      const { queueAcceptedWebSessionTerminalSnapshot } =
        await import('@/runtime/web-session-terminal-handle-events')
      const { transport, onPtyExit, endStream, answerStream } = await attachedMirror()
      // The stop ends the stream; the host still lists the handle without the fact, so the
      // client reattaches to the dead process, which ends at once, until the flaps back off.
      endStream('exited')
      for (const attempt of [2, 3]) {
        await vi.waitFor(() => expect(subscribeFrameCount()).toBe(attempt))
        answerStream({ type: 'subscribed', capabilities: { outputPause: 1 } })
        emitSnapshot(latestSubscribePayload().streamId, 'last screen')
        await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
        endStream('exited')
      }
      expect(transport.getRecoveryState?.().phase).toBe('backoff')

      queueAcceptedWebSessionTerminalSnapshot(hostFrame(fact), 'env-1')

      await vi.waitFor(
        () =>
          expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', undefined, {
            stoppedSwitchSource: fact
          }),
        { timeout: 500 }
      )
      expect(subscribeFrameCount()).toBe(3)
      transport.destroy?.()
    })

    it('takes the fact from main when its exited answer beats the frame', async () => {
      const { transport, onPtyExit, endStream, answerStream } = await attachedMirror()
      endStream('exited')
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      // Main recorded the fact before refusing the reattach; this client has not applied its frame.
      hostFact = fact
      answerStream({ type: 'error', message: 'terminal_exited' })
      answerStream({ type: 'end' })

      await vi.waitFor(() =>
        expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', undefined, {
          stoppedSwitchSource: fact
        })
      )
      expect(onPtyExit).toHaveBeenCalledTimes(1)
      expect(subscribeFrameCount()).toBe(2)
      transport.destroy?.()
    })

    it('keeps recovering when the host never proved a stop (host loss, or an older host)', async () => {
      const { transport, onPtyExit, endStream } = await attachedMirror()

      endStream('unverifiable')

      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      expect(onPtyExit).not.toHaveBeenCalled()
      transport.destroy?.()
    })
  }
)

it('parks a pane whose reattach keeps failing at the deadline: frames neither renew nor cost it work', async () => {
  resetRemoteRuntimeTransport()
  vi.useFakeTimers()
  try {
    const handleEvents = await import('@/runtime/web-session-terminal-handle-events')
    const { transport, endStream } = await attachedMirror()
    // Every reattach is refused recoverably, as by a host at its stream limit.
    subscriptionSendBinary.mockImplementation((bytes: Uint8Array<ArrayBufferLike>) => {
      const frame = decodeTerminalStreamFrame(bytes)
      const subscribe =
        frame?.opcode === TerminalStreamOpcode.Subscribe
          ? decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
          : null
      if (subscribe) {
        queueMicrotask(() => {
          const { streamId } = subscribe
          subscriptionCallbacks?.onResponse({
            ok: true,
            result: { type: 'error', streamId, message: TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR }
          })
          subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'end', streamId } })
        })
      }
    })
    endStream('exited')
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 6_000)
    const parked = transport.getRecoveryState?.()
    expect(parked?.phase).toBe('disconnected')
    expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
    const subscribes = subscribeFrameCount()

    for (let version = 3; version < 8; version += 1) {
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        { ...hostFrame(), snapshotVersion: version },
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(subscribeFrameCount()).toBe(subscribes)
    expect(transport.getRecoveryState?.()).toMatchObject({
      phase: 'disconnected',
      epoch: parked?.epoch
    })

    // Reconnect still revives it.
    expect(transport.retryRecovery?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(subscribeFrameCount()).toBeGreaterThan(subscribes)
    transport.destroy?.()
  } finally {
    vi.useRealTimers()
  }
})
