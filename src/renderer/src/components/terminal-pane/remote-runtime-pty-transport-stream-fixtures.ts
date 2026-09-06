import type { Mock } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'

export type MultiplexSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
} | null

type SubscribePayload = {
  streamId: number
  terminal: string
  client: { id: string; type: string }
  viewport?: { cols: number; rows: number }
  capabilities?: {
    ackOutput?: 1
    ackOutputSourceRanges?: 1
    desktopViewportClaims?: 1
    outputPause?: 1
    writeUnavailable?: 1
  }
}

/** Frame-level emitters/readers for the multiplex stream a remote PTY transport talks to. */
export function createTerminalStreamFixtures(bindings: {
  getCallbacks: () => MultiplexSubscriptionCallbacks
  sendBinary: Mock
}) {
  function emitMultiplexReady(): void {
    bindings.getCallbacks()?.onResponse({
      ok: true,
      result: { type: 'ready' }
    })
  }

  function latestSubscribePayload(): SubscribePayload {
    const frames = bindings.sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    const frame = frames.at(-1)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<SubscribePayload>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function subscribedTerminalHandles(): string[] {
    return bindings.sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return []
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        return payload ? [payload.terminal] : []
      })
  }

  function emitOutput(streamId: number, data: string, seq = 1): void {
    bindings.getCallbacks()?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq,
        payload: encodeTerminalStreamText(data)
      })
    )
  }

  function emitSnapshot(streamId: number, data: string): void {
    bindings.getCallbacks()?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    bindings.getCallbacks()?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    bindings.getCallbacks()?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function latestFrameForOpcode(opcode: TerminalStreamOpcode) {
    return bindings.sendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((frame) => frame?.opcode === opcode)
  }

  function emitSnapshotFrame(
    streamId: number,
    opcode:
      | TerminalStreamOpcode.SnapshotStart
      | TerminalStreamOpcode.SnapshotChunk
      | TerminalStreamOpcode.SnapshotEnd,
    payload: Uint8Array<ArrayBufferLike>
  ): void {
    bindings.getCallbacks()?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode,
        streamId,
        seq: 1,
        payload
      })
    )
  }

  return {
    emitMultiplexReady,
    latestSubscribePayload,
    subscribedTerminalHandles,
    emitOutput,
    emitSnapshot,
    latestFrameForOpcode,
    emitSnapshotFrame
  }
}
