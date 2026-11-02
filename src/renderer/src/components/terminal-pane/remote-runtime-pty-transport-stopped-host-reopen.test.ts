import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      throw new Error('These transport fixtures must not read app-store ownership')
    }
  }
}))

import { wslHostStoppedMessage } from '../../../../shared/wsl-host-stopped-message'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const ORIGINAL_ID = 'remote:env-1@@terminal-1'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const { runtimeCall, latestSubscribePayload, emitSnapshot, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => callbacks,
    setCallbacks: (value) => {
      callbacks = value
    },
    getResolvedPaneHandle: () => resolvedHandle,
    setResolvedPaneHandle: (value) => {
      resolvedHandle = value
    }
  })

beforeEach(resetRemoteRuntimeTransport)

async function completeAttach(): Promise<void> {
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const { streamId } = latestSubscribePayload()
  callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
  emitSnapshot(streamId, 'prompt$ ')
}

/** Every runtime call is refused the way main refuses one for a stopped distro, until `start()`. */
function stoppedHost(): { start: () => void } {
  let stopped = true
  const call = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    if (stopped) {
      throw new Error(
        `Error invoking remote method 'runtimeEnvironments:call': Error: ${wslHostStoppedMessage('Ubuntu')}`
      )
    }
    return call?.(request)
  })
  return {
    start: () => {
      stopped = false
    }
  }
}

describe('a restored remote pane whose host was stopped', () => {
  it.each(['connect', 'attach'] as const)(
    'reopens by %s once the host is running again, though its own retry has nothing armed',
    async (entry) => {
      const host = stoppedHost()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const onError = vi.fn()
      if (entry === 'connect') {
        void transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: { onError } })
      } else {
        transport.attach({ existingPtyId: ORIGINAL_ID, cols: 80, rows: 24, callbacks: { onError } })
      }
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
      await flushAsyncTicks()
      expect(transport.getPtyId()).toBeNull()

      host.start()
      // The refusal armed nothing, so the pane's own retry cannot bring it back.
      expect(transport.retryRecovery?.()).toBe(false)
      expect(transport.reopenAfterHostReturned?.()).toBe(true)
      await completeAttach()

      await vi.waitFor(() => expect(transport.getPtyId()).toBe(ORIGINAL_ID))
      // Connected now: a second host return does not open it again.
      expect(transport.reopenAfterHostReturned?.()).toBe(false)
      transport.destroy?.()
    }
  )

  it('leaves a pane that is still connecting to its own path', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    expect(transport.reopenAfterHostReturned?.()).toBe(false)
    void transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    expect(transport.reopenAfterHostReturned?.()).toBe(false)
    transport.destroy?.()
  })
})
