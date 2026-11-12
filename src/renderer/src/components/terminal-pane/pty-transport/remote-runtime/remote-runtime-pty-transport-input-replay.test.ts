import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'
import { runTerminalPasteOperationWithTimeout } from '../../input/paste/terminal-paste-operation-timeout'
import { writeTerminalPastePtyInput } from '../../input/paste/terminal-pty-paste-writer'
import { executeTerminalPastePlan } from '../../input/paste/terminal-paste-executor'
import type { TerminalPastePlan } from '../../input/paste/terminal-paste-model'
import { TERMINAL_REMOTE_PASTE_OPERATION_TIMEOUT_MS } from '../../input/paste/terminal-paste-limits'

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
  runtimeSubscribe,
  subscriptionSendBinary,
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
  onTestFinished(() => transport.destroy?.())
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
