import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import type { StoppedSwitchSourceFact } from '../../../../shared/stopped-switch-source'

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

const { runtimeCall, runtimeSubscribe, latestSubscribePayload, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

type Listing = { ok: true; result: { tabs: Record<string, unknown>[] } }

function stampHostRows(): void {
  const harnessCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: { method: string }) => {
    const reply = (await harnessCall?.(request)) as Listing
    if (request.method !== 'session.tabs.activate' || !hostFact) {
      return reply
    }
    const tabs = reply.result.tabs.map((tab) => ({ ...tab, stoppedSwitchSource: hostFact }))
    return { ...reply, result: { ...reply.result, tabs } }
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
  return { transport, onPtyExit, endStream }
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

      queueAcceptedWebSessionTerminalSnapshot(
        {
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
              stoppedSwitchSource: fact
            }
          ]
        },
        'env-1'
      )

      await vi.waitFor(() =>
        expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1', undefined, {
          stoppedSwitchSource: fact
        })
      )
      expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
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
