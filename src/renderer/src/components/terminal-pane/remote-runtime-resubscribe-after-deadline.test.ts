/**
 * Regression for #9092: a remote pane whose resubscribe attempt was still in flight when the
 * auto-recovery deadline latched dropped the late (recoverable) failure, so nothing was parked
 * and system resume / network online had nothing to fire. The pane stayed disconnected until
 * the user clicked Reconnect, even after the host came back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE } from '../../../../shared/remote-runtime-connect-bound'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

const FIRST_HANDLE = 'terminal-1'
const FIRST_PTY_ID = 'remote:env-1@@terminal-1'

describe('remote runtime resubscribe failing after the recovery deadline', () => {
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onClose?: () => void
  } | null = null
  let resolvePaneCalls = 0
  let holdResolvePane: { reject: (error: Error) => void } | null = null
  let hangLateResolvePane = true
  let streamOpens = 0
  const lateStreamOpen: { hang: boolean; release: (() => void) | null } = {
    hang: false,
    release: null
  }

  function latestStreamId(): number {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
    const payload = frame ? decodeTerminalStreamJson<{ streamId: number }>(frame.payload) : null
    if (!payload) {
      throw new Error('missing terminal subscribe frame')
    }
    return payload.streamId
  }

  function emitSnapshot(streamId: number): void {
    const frames = [
      { opcode: TerminalStreamOpcode.SnapshotStart, payload: encodeTerminalStreamJson({}) },
      { opcode: TerminalStreamOpcode.SnapshotChunk, payload: encodeTerminalStreamText('live') },
      { opcode: TerminalStreamOpcode.SnapshotEnd, payload: new Uint8Array() }
    ]
    frames.forEach((frame, index) =>
      subscriptionCallbacks?.onBinary?.(
        encodeTerminalStreamFrame({ ...frame, streamId, seq: index + 1 })
      )
    )
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
    }))
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    resolvePaneCalls = 0
    holdResolvePane = null
    hangLateResolvePane = true
    streamOpens = 0
    lateStreamOpen.hang = false
    lateStreamOpen.release = null
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        resolvePaneCalls += 1
        const params = request.params as { paneKey: string; worktreeId: string }
        if (hangLateResolvePane && holdResolvePane === null && resolvePaneCalls > 1) {
          // Why: the post-deadline attempt hangs so the test observes that it was issued.
          return new Promise<never>((_resolve, reject) => {
            holdResolvePane = { reject }
          })
        }
        return {
          ok: true,
          result: {
            terminal: {
              handle: FIRST_HANDLE,
              tabId: 'tab-1',
              leafId: 'pane:1',
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: FIRST_HANDLE } } }
    })
    const runtimeSubscribe = vi.fn(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        streamOpens += 1
        if (lateStreamOpen.hang && streamOpens > 1) {
          await new Promise<void>((resolve) => {
            lateStreamOpen.release = resolve
          })
        }
        subscriptionCallbacks = callbacks
        queueMicrotask(() =>
          subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
        )
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('parks the late failure so a resume trigger can revive the pane', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./remote-runtime-pty-recovery-state')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({ existingPtyId: FIRST_PTY_ID, cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestStreamId())
    expect(transport.isConnected()).toBe(true)

    vi.useFakeTimers()
    subscriptionCallbacks?.onClose?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(holdResolvePane).not.toBeNull())

    // The host stays unreachable past the whole auto-recovery window.
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    holdResolvePane?.reject(new Error(`${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE}.`))
    holdResolvePane = null
    await vi.advanceTimersByTimeAsync(0)

    const callsBeforeResume = resolvePaneCalls
    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvePaneCalls).toBeGreaterThan(callsBeforeResume)
    transport.destroy?.()
  })

  it('parks a late success whose stream opened after the deadline', async () => {
    hangLateResolvePane = false
    lateStreamOpen.hang = true
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./remote-runtime-pty-recovery-state')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({ existingPtyId: FIRST_PTY_ID, cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestStreamId())

    vi.useFakeTimers()
    subscriptionCallbacks?.onClose?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(lateStreamOpen.release).not.toBeNull())

    // The stream open stays in flight past the whole window, then succeeds.
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    lateStreamOpen.release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.getRecoveryState?.().phase).toBe('disconnected')

    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    transport.destroy?.()
  })
})
