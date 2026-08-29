/**
 * STA-3107 (blank-pane half): a paired client with SIX remote terminal tabs is
 * slept and woken. All six panes share one multiplex connection, so the sleep
 * closes every stream at once and all six recoveries race each other.
 *
 * Invariant: after the reconnect every pane resolves to a live host handle —
 * including a pane whose host PTY was parked while the client was away, which
 * only `session.tabs.activate` can re-materialize (the STA-3002 defect fixed by
 * #11542). No pane may be left with a null PTY id.
 *
 * The fault is injected at the multiplex transport seam (onClose), never with
 * elapsed time; the oracle is the per-pane handle inventory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'

type SubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

const PANE_COUNT = 6
const HOST_TAB_IDS = Array.from({ length: PANE_COUNT }, (_, index) => `host-tab-${index + 1}`)

describe('paired client sleep/wake with several remote terminal tabs', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: SubscriptionCallbacks | null = null
  /** Host handle currently published for each host tab; null models a parked surface. */
  let hostHandleByTabId = new Map<string, string | null>()

  function subscribedHandles(): string[] {
    return subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return []
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        return payload ? [payload.terminal] : []
      })
  }

  function surfaceFor(hostTabId: string): Record<string, unknown> {
    const handle = hostHandleByTabId.get(hostTabId) ?? null
    return {
      type: 'terminal',
      id: `${hostTabId}::pane:1`,
      parentTabId: hostTabId,
      leafId: 'pane:1',
      title: 'Terminal',
      isActive: false,
      ...(handle ? { status: 'ready', terminal: handle } : { status: 'pending' })
    }
  }

  function inventory(): unknown {
    return {
      ok: true,
      result: {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: HOST_TAB_IDS.map(surfaceFor)
      }
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    hostHandleByTabId = new Map(
      HOST_TAB_IDS.map((hostTabId, index) => [hostTabId, `terminal-${index + 1}`])
    )

    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate') {
        const params = request.params as { tabId: string }
        // Why: activation is the only call that mints a PTY for a parked surface.
        if (!hostHandleByTabId.get(params.tabId)) {
          hostHandleByTabId.set(params.tabId, `${params.tabId}-respawned`)
        }
        return inventory()
      }
      if (request.method === 'session.tabs.list') {
        return inventory()
      }
      return { ok: true, result: {} }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: SubscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  async function attachAllPanes(): Promise<
    { hostTabId: string; transport: { getPtyId: () => string | null; destroy?: () => void } }[]
  > {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const panes = HOST_TAB_IDS.map((hostTabId) => {
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: `web-terminal-${hostTabId}`,
        leafId: 'pane:1'
      })
      transport.attach({
        existingPtyId: `remote:env-1@@${hostHandleByTabId.get(hostTabId)}`,
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      return { hostTabId, transport }
    })
    await vi.waitFor(() => expect(subscribedHandles()).toHaveLength(PANE_COUNT))
    return panes
  }

  it('rebinds every pane after the shared multiplex connection drops', async () => {
    const panes = await attachAllPanes()
    const before = subscribedHandles().length

    // Laptop closed: the single multiplex socket dies, taking all six streams.
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() =>
      expect(subscribedHandles().length).toBeGreaterThanOrEqual(before + PANE_COUNT)
    )
    const afterReconnect = subscribedHandles().slice(before)
    expect(new Set(afterReconnect).size, `resubscribes: ${JSON.stringify(afterReconnect)}`).toBe(
      PANE_COUNT
    )
    for (const pane of panes) {
      expect(pane.transport.getPtyId(), `pane ${pane.hostTabId} lost its handle`).not.toBeNull()
      pane.transport.destroy?.()
    }
  })

  it('re-materializes a pane whose host PTY was parked while the client slept', async () => {
    const panes = await attachAllPanes()
    const before = subscribedHandles().length
    // One agent's host PTY went away while the laptop was closed; the host still
    // publishes the surface, but unmaterialized. This is the pane the reporter
    // sees as blank/black.
    const parked = HOST_TAB_IDS[2]!
    hostHandleByTabId.set(parked, null)

    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() =>
      expect(subscribedHandles().length).toBeGreaterThanOrEqual(before + PANE_COUNT)
    )
    const afterReconnect = subscribedHandles().slice(before)
    const evidence = `resubscribes: ${JSON.stringify(afterReconnect)}`
    expect(afterReconnect, evidence).toContain(`${parked}-respawned`)
    for (const pane of panes) {
      expect(pane.transport.getPtyId(), `pane ${pane.hostTabId} lost its handle`).not.toBeNull()
      pane.transport.destroy?.()
    }
  })
})
