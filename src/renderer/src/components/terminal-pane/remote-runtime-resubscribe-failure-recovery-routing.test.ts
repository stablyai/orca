/**
 * Pins the routing of a NON-RECOVERABLE resubscribe failure in
 * remote-runtime-pty-transport.
 *
 * `scheduleResubscribeAfterTransportClose` catches the rejection of
 * `resubscribeAfterTransportClose`. When the error is not a recoverable
 * connection error it must hand the error to `handleRemoteTerminalError`.
 * Surfacing the message directly instead looks harmless — the pane turns red
 * either way — but it skips four lifecycle routes, because none of these
 * messages appear in RECOVERABLE_MESSAGE_FRAGMENTS and so all of them land in
 * exactly this branch:
 *
 *   terminal_handle_stale            -> require-replacement resubscribe (or retire)
 *   terminal_gone / terminal_exited  -> retire the pane
 *   SSH_SESSION_EXPIRED              -> terminal.recoverPane on the hub
 *   snapshot-too-large               -> informational, no red error at all
 *
 * Fault-injection point: window.api.runtimeEnvironments.call, the Electron IPC
 * boundary the transport really uses. Each pane is first driven to a genuinely
 * connected state, then the multiplexed stream is closed so recovery starts
 * with a live epoch, and only the resubscribe attempt fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import type { PtyTransport } from './pty-transport-types'

type ResolvePaneOutcome = { handle: string } | { error: Error }

const PANE_TAB_ID = 'tab-1'
const PANE_LEAF_ID = 'pane:1'
const PANE_WORKTREE_ID = 'wt-1'
const FIRST_HANDLE = 'terminal-1'
const FIRST_PTY_ID = 'remote:env-1@@terminal-1'

describe('remote runtime resubscribe failure: recovery routing', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  /** Consumed in order by terminal.resolvePane; the last entry repeats. */
  let resolvePaneOutcomes: ResolvePaneOutcome[] = [{ handle: FIRST_HANDLE }]
  let recoverPaneOutcome: ResolvePaneOutcome = { handle: FIRST_HANDLE }
  let methodLog: string[] = []
  let subscribeOutcomes: (Error | null)[] = []

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
  }

  function latestSubscribePayload(): { streamId: number; terminal: string } {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{ streamId: number; terminal: string }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function subscribedTerminalHandles(): string[] {
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

  function emitSnapshot(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function nextOutcome(outcomes: ResolvePaneOutcome[]): ResolvePaneOutcome {
    return outcomes.length > 1 ? (outcomes.shift() as ResolvePaneOutcome) : outcomes[0]
  }

  function paneResult(handle: string, paneKey: string, worktreeId: string): unknown {
    const separator = paneKey.indexOf(':')
    return {
      ok: true,
      result: {
        terminal: {
          handle,
          tabId: paneKey.slice(0, separator),
          leafId: paneKey.slice(separator + 1),
          worktreeId
        }
      }
    }
  }

  /** Fails the pane's next resubscribe with `error`, then serves `thenHandle`. */
  function failNextResubscribeWith(error: Error, thenHandle = FIRST_HANDLE): void {
    resolvePaneOutcomes = [{ error }, { handle: thenHandle }]
    methodLog = []
  }

  async function attachLivePane(
    overrides: Partial<{ tabId: string; leafId: string }> & {
      onError?: (message: string) => void
      onPtyExit?: (ptyId: string) => void
      onPtyRebind?: (nextPtyId: string, previousPtyId: string) => void
    }
  ): Promise<PtyTransport> {
    const { onError, onPtyExit, onPtyRebind, ...ids } = overrides
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: PANE_WORKTREE_ID,
      ...('tabId' in ids ? { tabId: ids.tabId } : { tabId: PANE_TAB_ID }),
      ...('leafId' in ids ? { leafId: ids.leafId } : { leafId: PANE_LEAF_ID }),
      onPtyExit,
      onPtyRebind
    })
    transport.attach({
      existingPtyId: FIRST_PTY_ID,
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'live before the fault')
    expect(transport.isConnected()).toBe(true)
    return transport
  }

  /** Kills the multiplexed stream so the transport enters recovery with a live epoch. */
  function dropMultiplexedStream(): void {
    subscriptionCallbacks?.onClose?.()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    resolvePaneOutcomes = [{ handle: FIRST_HANDLE }]
    recoverPaneOutcome = { handle: FIRST_HANDLE }
    subscribeOutcomes = []
    methodLog = []
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      methodLog.push(request.method)
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const outcome = nextOutcome(resolvePaneOutcomes)
        if ('error' in outcome) {
          throw outcome.error
        }
        return paneResult(outcome.handle, params.paneKey, params.worktreeId)
      }
      if (request.method === 'terminal.recoverPane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        if ('error' in recoverPaneOutcome) {
          throw recoverPaneOutcome.error
        }
        return paneResult(recoverPaneOutcome.handle, params.paneKey, params.worktreeId)
      }
      return { ok: true, result: { terminal: { handle: FIRST_HANDLE } } }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        const outcome = subscribeOutcomes.shift()
        if (outcome) {
          throw outcome
        }
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  it('re-resolves and adopts the replacement handle when a resubscribe fails stale', async () => {
    const onError = vi.fn()
    const onPtyRebind = vi.fn()
    const transport = await attachLivePane({ onError, onPtyRebind })

    // The host fenced this handle during the outage and has already minted its
    // successor; only a require-replacement retry can reach it.
    failNextResubscribeWith(new Error('terminal_handle_stale'), 'terminal-2')
    dropMultiplexedStream()

    await vi.waitFor(() => expect(subscribedTerminalHandles()).toContain('terminal-2'))
    // Two resolvePane round-trips: the stale one, then the require-replacement retry.
    expect(methodLog.filter((method) => method === 'terminal.resolvePane')).toHaveLength(2)
    expect(onPtyRebind).toHaveBeenCalledWith('remote:env-1@@terminal-2', FIRST_PTY_ID)
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2')

    emitSnapshot(latestSubscribePayload().streamId, 'after replacement')
    expect(transport.isConnected()).toBe(true)
    expect(transport.getRecoveryState?.().phase).toBe('connected')
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('retires the pane when the stale resubscribe finds only the fenced handle', async () => {
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = await attachLivePane({ onError, onPtyExit })

    // Host still advertises the fenced handle; require-replacement forbids
    // reattaching to it, so the pane must retire rather than mirror a dead PTY.
    failNextResubscribeWith(new Error('terminal_handle_stale'), FIRST_HANDLE)
    dropMultiplexedStream()

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith(FIRST_PTY_ID))
    expect(methodLog.filter((method) => method === 'terminal.resolvePane')).toHaveLength(2)
    expect(subscribedTerminalHandles().filter((handle) => handle === FIRST_HANDLE)).toHaveLength(1)
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('retires a pane whose stale resubscribe has no tab/leaf ids to re-resolve', async () => {
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = await attachLivePane({
      tabId: undefined,
      leafId: undefined,
      onError,
      onPtyExit
    })

    // Without tab/leaf/worktree coordinates the resubscribe goes straight back
    // to the multiplexer, and a stale rejection there has nothing to re-resolve.
    subscribeOutcomes = [new Error('terminal_handle_stale')]
    dropMultiplexedStream()

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith(FIRST_PTY_ID))
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('retires the pane when a resubscribe fails with terminal-gone', async () => {
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = await attachLivePane({ onError, onPtyExit })

    failNextResubscribeWith(new Error('terminal_gone'))
    dropMultiplexedStream()

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith(FIRST_PTY_ID))
    // Lifecycle evidence, not a replaceable handle: no second re-resolve.
    expect(methodLog.filter((method) => method === 'terminal.resolvePane')).toHaveLength(1)
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('recovers the host pane when a resubscribe fails with an expired SSH session', async () => {
    const onError = vi.fn()
    const onPtyRebind = vi.fn()
    const transport = await attachLivePane({ onError, onPtyRebind })

    recoverPaneOutcome = { handle: 'terminal-3' }
    failNextResubscribeWith(new Error('SSH_SESSION_EXPIRED'))
    dropMultiplexedStream()

    await vi.waitFor(() => expect(methodLog).toContain('terminal.recoverPane'))
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.recoverPane',
        params: {
          paneKey: `${PANE_TAB_ID}:${PANE_LEAF_ID}`,
          worktreeId: PANE_WORKTREE_ID,
          expectedTerminal: FIRST_HANDLE
        }
      })
    )
    await vi.waitFor(() => expect(subscribedTerminalHandles()).toContain('terminal-3'))
    expect(onPtyRebind).toHaveBeenCalledWith('remote:env-1@@terminal-3', FIRST_PTY_ID)

    emitSnapshot(latestSubscribePayload().streamId, 'after ssh pane recovery')
    expect(transport.isConnected()).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('keeps an oversized-snapshot resubscribe failure informational', async () => {
    const { REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE } =
      await import('../../runtime/remote-runtime-terminal-multiplexer')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = await attachLivePane({ onError, onPtyExit })

    failNextResubscribeWith(new Error(REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE))
    dropMultiplexedStream()

    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('disconnected'))
    // The snapshot was skipped, not the terminal: no red banner, no retirement.
    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe(FIRST_PTY_ID)
    transport.destroy?.()
  })
})
