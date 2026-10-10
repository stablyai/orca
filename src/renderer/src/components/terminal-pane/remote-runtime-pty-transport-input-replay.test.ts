import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS } from './remote-runtime-disconnected-input-grace'
import { runTerminalPasteOperationWithTimeout } from './terminal-paste-operation-timeout'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import type { TerminalPastePlan } from './terminal-paste-model'
import { TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS } from './terminal-paste-limits'
import {
  REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION,
  REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS
} from './remote-runtime-input-journal'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  subscriptionSendBinary,
  emitMultiplexReady,
  latestSubscribePayload,
  emitSnapshot,
  subscribeFrameCount,
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

type SentInput = { seq: number; text: string }

/** Input frames sent after the `subscribeCount`-th Subscribe frame (stream ids restart per connection). */
function sentInputs(subscribeCount = 0): SentInput[] {
  let subscribes = 0
  return subscriptionSendBinary.mock.calls.flatMap(([bytes]) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (frame?.opcode === TerminalStreamOpcode.Subscribe) {
      subscribes += 1
    }
    return frame?.opcode === TerminalStreamOpcode.Input && subscribes >= subscribeCount
      ? [{ seq: frame.seq, text: decodeTerminalStreamText(frame.payload) }]
      : []
  })
}

function sentText(): string {
  return sentInputs()
    .map((input) => input.text)
    .join('')
}

/** Real hosts publish `subscribed` before the snapshot that completes the attach. */
function attachStream(
  streamId: number,
  capabilities: Record<string, 1>,
  inputLedgerId = 'ledger-1'
): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: {
      type: 'subscribed',
      streamId,
      capabilities,
      ...(capabilities.inputAck ? { inputLedgerId } : {})
    }
  })
  emitSnapshot(streamId, 'prompt$ ')
}

const RESEND_REQUEST = Uint8Array.of(2)

function emitInputAck(streamId: number, seq: number, payload = new Uint8Array()): void {
  subscriptionCallbacks?.onBinary?.(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.InputAck,
      streamId,
      seq,
      payload
    })
  )
}

/** Makes the `failAt`-th Input frame sent from now on throw, as a socket that died mid-write does. */
function failInputFrame(failAt: number): void {
  let inputs = 0
  subscriptionSendBinary.mockImplementation((bytes: Uint8Array) => {
    if (decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Input) {
      inputs += 1
      if (inputs === failAt) {
        subscriptionSendBinary.mockImplementation(() => {})
        throw new Error('socket closed')
      }
    }
  })
}

/** One chunked-paste write, bounded by the remote paste timeout like the paste executor's. */
function pasteChunk(transport: Parameters<typeof writeTerminalPastePtyInput>[0], data: string) {
  return runTerminalPasteOperationWithTimeout(
    (signal) => writeTerminalPastePtyInput(transport, data, 'driving', signal),
    TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS
  )
}

async function connectPane(
  capabilities: Record<string, 1>,
  callbacks: { onWriteUnavailable?: () => void } = {}
) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  transport.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks })
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
  const streamId = latestSubscribePayload().streamId
  attachStream(streamId, capabilities)
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  return { transport, streamId }
}

async function reconnect(
  capabilities: Record<string, 1>,
  attempt: number,
  inputLedgerId?: string
): Promise<void> {
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(attempt))
  attachStream(latestSubscribePayload().streamId, capabilities, inputLedgerId)
}

describe('remote pane input across a silent outage', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('names an input session and negotiates acks on subscribe', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    const payload = latestSubscribePayload()
    expect(payload.capabilities).toMatchObject({ inputAck: 1 })
    expect(payload.inputSessionId).toEqual(expect.any(String))
    transport.destroy?.()
  })

  it('replays input the dead stream never acknowledged onto the replacement stream (P1-1)', async () => {
    const { transport, streamId } = await connectPane({ inputAck: 1 })
    transport.sendInput('echo 1\r', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
    emitInputAck(streamId, sentInputs()[0].seq)
    // Typed after the link went silent but before liveness noticed: handed to the dead socket.
    transport.sendInput('echo 2\r', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(2))
    const lostSeq = sentInputs()[1].seq

    subscriptionCallbacks?.onClose?.()
    expect(transport.sendInput('echo 3\r', 'driving')).toBe(true)
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)

    await vi.waitFor(() =>
      expect(sentInputs(2)).toEqual([
        { seq: lostSeq, text: 'echo 2\r' },
        { seq: lostSeq + 1, text: 'echo 3\r' }
      ])
    )
    transport.destroy?.()
  })

  it('drops unacknowledged input instead of replaying it into a restarted host runtime', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    // Applied by the old runtime, but its ack died with the link.
    transport.sendInput('make deploy\r', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    // Same handle and PTY, but the runtime restarted, so its dedupe ledger is new.
    await reconnect({ inputAck: 1 }, 2, 'ledger-after-restart')
    transport.sendInput('ls\r', 'driving')

    await vi.waitFor(() => expect(sentInputs(2).map((input) => input.text)).toEqual(['ls\r']))
    transport.destroy?.()
  })

  it('keeps Ctrl+C in sequence with typing across a silent outage', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    transport.sendInput('echo canceled', 'driving')
    const interrupted = transport.sendInputAccepted?.('\x03', 'driving')
    await vi.waitFor(() => expect(sentText()).toBe('echo canceled\x03'))
    transport.sendInput('echo next\r', 'driving')
    await vi.waitFor(() => expect(sentText()).toBe('echo canceled\x03echo next\r'))

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)

    await vi.waitFor(() =>
      expect(
        sentInputs(2)
          .map((input) => input.text)
          .join('')
      ).toBe('echo canceled\x03echo next\r')
    )
    // A live host acks every replayed frame on its own.
    for (const replayed of sentInputs(2)) {
      emitInputAck(latestSubscribePayload().streamId, replayed.seq)
    }
    await expect(interrupted).resolves.toBe(true)
    transport.destroy?.()
  })

  it('keeps a paste still in size validation ahead of keys typed after the outage', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    const paste = 'A'.repeat(300 * 1024)
    transport.sendInput(paste, 'driving')
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Could not connect to the remote Orca runtime.'
    })
    transport.sendInput('B\r', 'driving')

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)

    // Why the long timeout: 300 KiB byte-length validation yields and is slow on a loaded runner.
    await vi.waitFor(() => expect(sentText()).toBe(`${paste}B\r`), { timeout: 10_000 })
    transport.destroy?.()
  })

  it('never replays toward a host that does not acknowledge input', async () => {
    const { transport } = await connectPane({ outputPause: 1 })
    transport.sendInput('echo 1\r', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
    expect(sentInputs()[0].seq).toBe(0)

    subscriptionCallbacks?.onClose?.()
    transport.sendInput('echo 2\r', 'driving')
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ outputPause: 1 }, 2)

    await vi.waitFor(() => expect(sentInputs(2)).toEqual([{ seq: 0, text: 'echo 2\r' }]))
    transport.destroy?.()
  })

  it('keeps debounced keys pending at detection instead of splitting the line (P1-2)', async () => {
    const { transport } = await connectPane({ outputPause: 1 })
    for (const ch of 'PZ600-0') {
      transport.sendInput(ch, 'driving')
    }
    await vi.waitFor(() => expect(sentText()).toBe('PZ600-0'))
    // Still inside the 8 ms debounce when the outage is detected.
    transport.sendInput('1', 'driving')
    transport.sendInput('2', 'driving')
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Could not connect to the remote Orca runtime.'
    })
    transport.sendInput('3', 'driving')
    transport.sendInput('\r', 'driving')

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ outputPause: 1 }, 2)

    await vi.waitFor(() => expect(sentText()).toBe('PZ600-0123\r'))
    transport.destroy?.()
  })

  it('keeps input held past the auto-recovery window and delivers it when the same terminal returns within the grace (P1-3)', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await connectPane({ inputAck: 1 })
      let hostReachable = false
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<MultiplexSubscriptionCallbacks>) => {
          if (!hostReachable) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          subscriptionCallbacks = callbacks
          queueMicrotask(emitMultiplexReady)
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )

      subscriptionCallbacks?.onClose?.()
      expect(transport.sendInput('HELD-1\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      // Typed under the "disconnected" banner: still held for the same terminal.
      expect(transport.sendInput('LATE-2\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 60_000)

      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      attachStream(latestSubscribePayload().streamId, { inputAck: 1 })
      await vi.advanceTimersByTimeAsync(50)

      expect(
        sentInputs(2)
          .map((input) => input.text)
          .join('')
      ).toBe('HELD-1\rLATE-2\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never delivers a paste chunk held past its caller timeout under the disconnected banner', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await connectPane({ inputAck: 1 })
      let hostReachable = false
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<MultiplexSubscriptionCallbacks>) => {
          if (!hostReachable) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          subscriptionCallbacks = callbacks
          queueMicrotask(emitMultiplexReady)
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )

      subscriptionCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      const paste = pasteChunk(transport, '\x1b[200~echo one\recho two\r')
      await vi.advanceTimersByTimeAsync(TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS + 10_000)
      await expect(paste).resolves.toEqual({ timedOut: true })
      // Typed after the paste error: still held for the same terminal.
      transport.sendInput('ls\r', 'driving')

      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      attachStream(latestSubscribePayload().streamId, { inputAck: 1 })
      await vi.advanceTimersByTimeAsync(50)

      expect(
        sentInputs(2)
          .map((input) => input.text)
          .join('')
      ).toBe('ls\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops input held or typed past the disconnected grace instead of running it at a later reconnect', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await connectPane({ inputAck: 1 })
      let hostReachable = false
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<MultiplexSubscriptionCallbacks>) => {
          if (!hostReachable) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          subscriptionCallbacks = callbacks
          queueMicrotask(emitMultiplexReady)
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )

      subscriptionCallbacks?.onClose?.()
      transport.sendInput('HELD-1\r', 'driving')
      await vi.advanceTimersByTimeAsync(
        REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS + 1_000
      )
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      // Typed into the dead pane long after it gave up.
      expect(transport.sendInput('git push -f\r', 'driving')).toBe(false)

      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      attachStream(latestSubscribePayload().streamId, { inputAck: 1 })
      await vi.advanceTimersByTimeAsync(50)
      transport.sendInput('ls\r', 'driving')
      await vi.advanceTimersByTimeAsync(50)

      expect(
        sentInputs(2)
          .map((input) => input.text)
          .join('')
      ).toBe('ls\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never replays a paste chunk the dead stream took after its caller timed out', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await connectPane({ inputAck: 1 })
      const paste = pasteChunk(transport, '\x1b[200~echo one\r')
      await vi.advanceTimersByTimeAsync(20)
      expect(sentText()).toBe('\x1b[200~echo one\r')
      // The link goes silent before the host acks the chunk; the stall watchdog starts recovery.
      await vi.advanceTimersByTimeAsync(TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS + 1_000)
      await expect(paste).resolves.toEqual({ timedOut: true })
      expect(subscribeFrameCount()).toBeGreaterThan(1)
      transport.sendInput('ls\r', 'driving')

      const reattach = subscribeFrameCount()
      attachStream(latestSubscribePayload().streamId, { inputAck: 1 })
      await vi.advanceTimersByTimeAsync(50)

      // The given-up chunk's slot is filled empty so the host, which writes in order, can go on.
      expect(sentInputs(reattach).map((input) => input.text)).toEqual(['', 'ls\r'])
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps typing batched just before a paste when that paste is given up', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await connectPane({ inputAck: 1 })
      // Typed and pasted inside one input debounce, while the link silently stops delivering.
      transport.sendInput('echo retained ', 'driving')
      const paste = pasteChunk(transport, '\x1b[200~rm -rf build\r')
      await vi.advanceTimersByTimeAsync(20)
      await vi.advanceTimersByTimeAsync(TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS + 1_000)
      await expect(paste).resolves.toEqual({ timedOut: true })
      expect(subscribeFrameCount()).toBeGreaterThan(1)

      const reattach = subscribeFrameCount()
      attachStream(latestSubscribePayload().streamId, { inputAck: 1 })
      await vi.advanceTimersByTimeAsync(50)

      expect(sentInputs(reattach).map((input) => input.text)).toEqual(['echo retained ', ''])
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resends input the host refused on the same live stream, without remounting, and keeps later typing flowing', async () => {
    const onWriteUnavailable = vi.fn()
    const { transport, streamId } = await connectPane({ inputAck: 1 }, { onWriteUnavailable })
    transport.sendInput('a', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
    emitInputAck(streamId, 1)
    transport.sendInput('b', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(2))
    transport.sendInput('c', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(3))

    // The host's PTY briefly refused seq 2 and wrote nothing after it.
    emitInputAck(streamId, 1, RESEND_REQUEST)
    emitInputAck(streamId, 1, RESEND_REQUEST)
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(5))
    expect(sentInputs().slice(3)).toEqual([
      { seq: 2, text: 'b' },
      { seq: 3, text: 'c' }
    ])
    emitInputAck(streamId, 3)
    transport.sendInput('d', 'driving')
    await vi.waitFor(() => expect(sentInputs().at(-1)).toEqual({ seq: 4, text: 'd' }))
    expect(subscribeFrameCount()).toBe(1)
    expect(onWriteUnavailable).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('keeps resending through transient refusals, then falls back to a remount once they persist', async () => {
    vi.useFakeTimers()
    try {
      const onWriteUnavailable = vi.fn()
      const { transport, streamId } = await connectPane({ inputAck: 1 }, { onWriteUnavailable })
      transport.sendInput('a', 'driving')
      await vi.advanceTimersByTimeAsync(20)
      for (
        let round = 1;
        round < REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION;
        round += 1
      ) {
        emitInputAck(streamId, 0, RESEND_REQUEST)
        await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_INPUT_RESEND_BACKOFF_MS.at(-1) ?? 0)
      }
      expect(sentInputs().filter((input) => input.text === 'a').length).toBeGreaterThanOrEqual(
        REMOTE_RUNTIME_INPUT_REFUSAL_ROUNDS_BEFORE_ESCALATION
      )
      expect(onWriteUnavailable).not.toHaveBeenCalled()
      // The refusal never clears (a stale handle or an unwritable PTY on a live stream).
      emitInputAck(streamId, 0, RESEND_REQUEST)
      expect(onWriteUnavailable).toHaveBeenCalledTimes(1)
      emitInputAck(streamId, 0, RESEND_REQUEST)
      expect(onWriteUnavailable).toHaveBeenCalledTimes(1)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an accepted write as not applied when a later cumulative ack covers its lost ack', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    const opener = transport.sendInputAccepted?.('\x1b[200~', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
    // Its delivery-unknown ack died with the connection; the replacement acks a later write.
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)
    transport.sendInput('x', 'driving')
    await vi.waitFor(() => expect(sentInputs(2)).toHaveLength(2))
    emitInputAck(latestSubscribePayload().streamId, sentInputs(2)[1].seq)
    await expect(opener).resolves.toBe(false)
    transport.destroy?.()
  })

  it('cancels a bracketed paste whose opener ack was lost, without sending the multiline body', async () => {
    const { transport } = await connectPane({ inputAck: 1 })
    const body = 'echo first\necho second\n'
    const plan: TerminalPastePlan = {
      target: {
        kind: 'terminal',
        paneId: 1,
        leafId: 'pane:1',
        ptyId: 'remote:terminal-1',
        runtime: { platform: 'linux', runtimeKey: 'remote', kind: 'remote-runtime' }
      },
      payload: {
        plainText: body,
        source: 'keyboard',
        byteLength: body.length,
        lineCount: 2,
        hasRichText: false,
        hasControlSequences: false,
        lineEndingByteLength: 2
      },
      mode: 'chunked',
      newlinePolicy: 'preserve',
      runtimeKey: 'remote',
      bracketed: true,
      redactedDiagnostic: ''
    }
    const pasted = executeTerminalPastePlan(plan, {
      pasteText: () => {},
      writePty: (data, signal) => writeTerminalPastePtyInput(transport, data, 'driving', signal)
    })
    await vi.waitFor(() => expect(sentText()).toBe('\x1b[200~'))
    // The opener's delivery-unknown ack dies with the connection; the host answers the resend as unknown.
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)
    await vi.waitFor(() => expect(sentInputs(2)).toHaveLength(1))
    emitInputAck(latestSubscribePayload().streamId, sentInputs(2)[0].seq, Uint8Array.of(1))

    await expect(pasted).resolves.toMatchObject({ status: 'cancelled' })
    expect(sentText()).not.toContain('echo first')
    transport.destroy?.()
  })

  it('reports an accepted write the host failed with unknown delivery as not sent, and never replays it', async () => {
    const { transport, streamId } = await connectPane({ inputAck: 1 })
    const write = transport.sendInputAccepted?.('make deploy\r', 'driving')
    await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
    emitInputAck(streamId, sentInputs()[0].seq, Uint8Array.of(1))
    await expect(write).resolves.toBe(false)

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await reconnect({ inputAck: 1 }, 2)
    transport.sendInput('ls\r', 'driving')
    await vi.waitFor(() => expect(sentInputs(2).map((input) => input.text)).toEqual(['ls\r']))
    transport.destroy?.()
  })

  it.each([1, 2])(
    'keeps earlier typing and the whole draft when chunk %i of an accepted write fails to send',
    async (failingChunk) => {
      const { transport } = await connectPane({ inputAck: 1 })
      transport.sendInput('echo previous\r', 'driving')
      await vi.waitFor(() => expect(sentInputs()).toHaveLength(1))
      // A 48 KiB startup draft splits into three 16 KiB chunks.
      const draft = `${'a'.repeat(16 * 1024)}${'b'.repeat(16 * 1024)}${'c'.repeat(16 * 1024)}`
      failInputFrame(failingChunk)
      const write = transport.sendInputAccepted?.(draft, 'driving')

      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      await reconnect({ inputAck: 1 }, 2)
      await vi.waitFor(() =>
        expect(
          sentInputs(2)
            .map((input) => input.text)
            .join('')
        ).toBe(`echo previous\r${draft}`)
      )
      for (const replayed of sentInputs(2)) {
        emitInputAck(latestSubscribePayload().streamId, replayed.seq)
      }
      await expect(write).resolves.toBe(true)
      transport.destroy?.()
    }
  )
})
