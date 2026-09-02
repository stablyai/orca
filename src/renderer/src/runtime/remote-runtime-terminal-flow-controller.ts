import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_ACK_FLUSH_MS
} from '../../../shared/terminal-multiplex-flow-control'
import { RemoteRuntimeTerminalSnapshotController } from './remote-runtime-terminal-snapshot-controller'
import { clearAckFlushTimer } from './remote-runtime-terminal-snapshot-state'
import type { RemoteRuntimeMultiplexedTerminalState } from './remote-runtime-terminal-multiplexer-types'

export abstract class RemoteRuntimeTerminalFlowController extends RemoteRuntimeTerminalSnapshotController {
  private acknowledgeOutput(stream: RemoteRuntimeMultiplexedTerminalState, bytes: number): boolean {
    if (stream.acknowledgeOutputSourceRanges && stream.streamGeneration) {
      const ackedEndByte = stream.sourceAckedEndByte + bytes
      const sent = this.sendFrame(
        stream.streamId,
        TerminalStreamOpcode.Ack,
        encodeTerminalStreamJson({
          streamGeneration: stream.streamGeneration,
          ackedEndByte
        })
      )
      if (sent) {
        stream.sourceAckedEndByte = ackedEndByte
      }
      return sent
    }
    return this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Ack,
      encodeTerminalStreamJson({ bytes })
    )
  }

  // Why: sendFrame gates on readiness alone; a dropped handle would still report success.
  protected isRegisteredStream(stream: RemoteRuntimeMultiplexedTerminalState): boolean {
    return this.streams.get(stream.streamId) === stream
  }

  protected sendInput(stream: RemoteRuntimeMultiplexedTerminalState, text: string): boolean {
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Input,
      encodeTerminalStreamText(text)
    )
    if (sent && !stream.outputPaused) {
      stream.watchdog.recordCommandInput(text)
    }
    return sent
  }

  protected setOutputPaused(
    stream: RemoteRuntimeMultiplexedTerminalState,
    paused: boolean
  ): boolean {
    if (!stream.supportsOutputPause || this.streams.get(stream.streamId) !== stream) {
      return false
    }
    if (stream.outputPaused === paused) {
      return true
    }
    const sent = this.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.SetOutputPaused,
      encodeTerminalStreamJson({ paused })
    )
    if (sent) {
      stream.outputPaused = paused
    }
    return sent
  }

  protected queueOutputAcknowledgement(
    stream: RemoteRuntimeMultiplexedTerminalState,
    bytes: number
  ): boolean {
    if (this.streams.get(stream.streamId) !== stream) {
      return true
    }
    stream.pendingAckBytes += bytes
    if (stream.pendingAckBytes >= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES) {
      return this.flushOutputAcknowledgement(stream)
    }
    if (stream.ackFlushTimer === null) {
      stream.ackFlushTimer = setTimeout(() => {
        stream.ackFlushTimer = null
        this.flushOutputAcknowledgement(stream)
      }, TERMINAL_MULTIPLEX_ACK_FLUSH_MS)
    }
    return true
  }

  private flushOutputAcknowledgement(stream: RemoteRuntimeMultiplexedTerminalState): boolean {
    clearAckFlushTimer(stream)
    const bytes = stream.pendingAckBytes
    stream.pendingAckBytes = 0
    return bytes <= 0 || this.acknowledgeOutput(stream, bytes)
  }

  getStreamsForE2e(): Iterable<RemoteRuntimeMultiplexedTerminalState> {
    return this.streams.values()
  }

  forceErrorForE2e(terminals: ReadonlySet<string>, message: string): number {
    let dispatched = 0
    for (const stream of this.streams.values()) {
      if (terminals.has(stream.terminal)) {
        stream.callbacks.onError?.(message)
        dispatched += 1
      }
    }
    return dispatched
  }

  releaseHeldAcksForE2e(): number {
    let released = 0
    for (const stream of this.streams.values()) {
      if (stream.heldAckBytes <= 0) {
        continue
      }
      const bytes = stream.heldAckBytes
      stream.heldAckBytes = 0
      if (this.queueOutputAcknowledgement(stream, bytes)) {
        released += bytes
      }
    }
    return released
  }

  sendInputForE2e(terminal: string, text: string): number {
    let sent = 0
    for (const stream of this.streams.values()) {
      if (stream.terminal === terminal && this.sendInput(stream, text)) {
        sent += 1
      }
    }
    return sent
  }
}
