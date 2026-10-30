import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

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
  emitSnapshot,
  runtimeCall,
  latestSubscribePayload,
  subscribeFrameCount,
  subscribedTerminalHandles,
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

// What a host sends when its window did not mount the pane within its 10 s wait.
function answerUnmountedHostPane(streamId: number): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: { type: 'error', streamId, message: 'no_connected_pty' }
  })
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'end', streamId } })
}

async function connectPane(onPtyExit: (ptyId: string, exitCode?: number) => void) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onExit = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:2',
    onPtyExit
  })
  await transport.connect({ url: '', callbacks: { onExit } })
  return { transport, onExit }
}

describe('remote runtime PTY whose host pane is not mounted yet', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps the pane and reattaches once the host mounts it', async () => {
    const onPtyExit = vi.fn()
    const { transport, onExit } = await connectPane(onPtyExit)

    answerUnmountedHostPane(latestSubscribePayload().streamId)

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    emitSnapshot(latestSubscribePayload().streamId, 'host mounted the pane')
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(onPtyExit).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('retires the pane as lost, not exited, when the host stops listing it', async () => {
    const onPtyExit = vi.fn()
    const { transport, onExit } = await connectPane(onPtyExit)
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        return { ok: false, error: { code: 'runtime_error', message: 'terminal_not_found' } }
      }
      return defaultCall?.(args)
    })

    answerUnmountedHostPane(latestSubscribePayload().streamId)

    // Why -1: the host-loss sentinel; a pane the host stopped listing is not proof of exit.
    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', -1))
    expect(onPtyExit).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(subscribeFrameCount()).toBe(1)
    transport.destroy?.()
  })

  it('backs off and settles disconnected, not exited, when the host never mounts it', async () => {
    vi.useFakeTimers()
    try {
      const onPtyExit = vi.fn()
      const { transport, onExit } = await connectPane(onPtyExit)
      let answered = 0
      const answerNewSubscribes = (): void => {
        while (answered < subscribeFrameCount()) {
          answered += 1
          answerUnmountedHostPane(latestSubscribePayload().streamId)
        }
      }

      answerNewSubscribes()
      await vi.advanceTimersByTimeAsync(200)
      // Why: an old host answers at once, so an immediate resubscribe would spin.
      expect(subscribeFrameCount()).toBe(1)
      for (let elapsed = 0; elapsed <= REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS; elapsed += 1_000) {
        answerNewSubscribes()
        await vi.advanceTimersByTimeAsync(1_000)
      }

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      const subscribesAtCutoff = subscribeFrameCount()
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect(subscribeFrameCount()).toBe(subscribesAtCutoff)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
