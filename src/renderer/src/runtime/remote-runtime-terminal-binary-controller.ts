import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import {
  shouldDropE2eRemoteTerminalOutput,
  shouldHoldE2eRemoteTerminalAck
} from './remote-runtime-terminal-e2e-control'
import { RemoteRuntimeTerminalBinarySnapshots } from './remote-runtime-terminal-binary-snapshots'
import type { RemoteRuntimeMultiplexedTerminalState } from './remote-runtime-terminal-multiplexer-types'

export abstract class RemoteRuntimeTerminalBinaryController extends RemoteRuntimeTerminalBinarySnapshots {
  protected handleBinary(bytes: Uint8Array<ArrayBufferLike>): void {
    if (!this.matchesCurrentEnvironmentRevision()) {
      this.closeForEnvironmentReplacement()
      return
    }
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      // Why: malformed framing cannot be credited safely; closing makes the server release every stream window.
      this.failConnection(new Error('Remote terminal stream received a malformed frame.'))
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      if (
        frame.opcode === TerminalStreamOpcode.Output ||
        frame.opcode === TerminalStreamOpcode.OutputSpan
      ) {
        // Why: the renderer already disposed this stream; unsubscribe releases server credit that cannot reach a parser.
        this.sendFrame(frame.streamId, TerminalStreamOpcode.Unsubscribe)
      }
      return
    }
    if (
      (frame.opcode === TerminalStreamOpcode.Output ||
        frame.opcode === TerminalStreamOpcode.OutputSpan) &&
      shouldDropE2eRemoteTerminalOutput(stream, frame.payload.byteLength)
    ) {
      this.queueOutputAcknowledgement(stream, frame.payload.byteLength)
      return
    }
    stream.watchdog.recordInbound()
    if (frame.opcode === TerminalStreamOpcode.WriteUnavailable) {
      stream.callbacks.onWriteUnavailable?.()
      return
    }
    if (
      frame.opcode === TerminalStreamOpcode.Output ||
      frame.opcode === TerminalStreamOpcode.OutputSpan
    ) {
      this.handleOutputFrame(frame, stream)
      return
    }
    this.handleSnapshotOrErrorFrame(frame, stream)
  }

  private handleOutputFrame(
    frame: TerminalStreamFrame,
    stream: RemoteRuntimeMultiplexedTerminalState
  ): void {
    const span =
      frame.opcode === TerminalStreamOpcode.OutputSpan
        ? decodeTerminalStreamJson<{
            data?: unknown
            rawLength?: unknown
            transformed?: unknown
          }>(frame.payload)
        : null
    const validSpan =
      frame.opcode !== TerminalStreamOpcode.OutputSpan ||
      (typeof span?.data === 'string' &&
        typeof span.rawLength === 'number' &&
        Number.isSafeInteger(span.rawLength) &&
        span.rawLength >= 0 &&
        span.transformed === true)
    const data =
      frame.opcode === TerminalStreamOpcode.OutputSpan
        ? validSpan
          ? (span!.data as string)
          : ''
        : decodeTerminalStreamText(frame.payload)
    const deliverOutput = (): void => {
      if (!validSpan) {
        // Why: rendering malformed span JSON would expose protocol framing
        // as terminal text and lose its raw sequence accounting.
        this.requestResyncSnapshot(stream)
        return
      }
      const rawLength =
        frame.opcode === TerminalStreamOpcode.OutputSpan && typeof span?.rawLength === 'number'
          ? span.rawLength
          : data.length
      // Why: a resync snapshot is authoritative; discard live output while
      // it is in flight, but still return transport credit in finally.
      if (stream.resyncInFlight) {
        return
      }
      const seq = typeof frame.seq === 'number' && frame.seq > 0 ? frame.seq : undefined
      // Why: older servers replay snapshot-covered buffered chunks after a
      // requested recovery; rendering them would duplicate the recovered tail.
      if (
        typeof seq === 'number' &&
        typeof stream.recoverySnapshotSeq === 'number' &&
        seq <= stream.recoverySnapshotSeq
      ) {
        return
      }
      if (this.detectOutputGap(stream, seq, rawLength)) {
        this.requestResyncSnapshot(stream)
        return
      }
      if (typeof seq === 'number') {
        stream.expectedSeq = seq
        stream.commandProbeBaselineSeq = undefined
      }
      stream.callbacks.onData(data, {
        seq,
        rawLength,
        ...(frame.opcode === TerminalStreamOpcode.OutputSpan ? { transformed: true } : {})
      })
    }
    if (!stream.acknowledgeOutput) {
      deliverOutput()
      return
    }
    try {
      const settleWatchdog = stream.watchdog.beginOutputDelivery(frame.payload.byteLength)
      deliverTerminalDataWithDeferredCredit(() => {
        settleWatchdog()
        if (shouldHoldE2eRemoteTerminalAck(stream.terminal)) {
          stream.heldAckBytes += frame.payload.byteLength
        } else {
          this.queueOutputAcknowledgement(stream, frame.payload.byteLength)
        }
      }, deliverOutput)
    } catch (error) {
      this.failConnection(
        error instanceof Error ? error : new Error('Remote terminal output delivery failed.')
      )
    }
  }
}
