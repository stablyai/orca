import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR } from '../../../shared/terminal-multiplex-flow-control'
import { parseTerminalStreamEndVerdict } from '../../../shared/terminal-stream-end-verdict'
import { shouldHoldE2eRemoteTerminalEnd } from './remote-runtime-terminal-e2e-control'
import { RemoteRuntimeTerminalFlowController } from './remote-runtime-terminal-flow-controller'
import {
  clearResyncTimer,
  clearSnapshot,
  discardOutputAcknowledgements,
  isTerminalDriverState,
  rejectPendingSnapshotRequest
} from './remote-runtime-terminal-snapshot-state'
import type { TerminalMultiplexEvent } from './remote-runtime-terminal-multiplexer-types'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'

type SubscribedCapabilities = {
  ackOutputSourceRanges: boolean
  outputPause: boolean
  inputAck: boolean
}

// Why parse: the frame comes off the wire, so a malformed or legacy capabilities value must read as "unsupported".
function parseSubscribedCapabilities(value: unknown): SubscribedCapabilities {
  if (typeof value !== 'object' || value === null) {
    return { ackOutputSourceRanges: false, outputPause: false, inputAck: false }
  }
  const record: { ackOutputSourceRanges?: unknown; outputPause?: unknown; inputAck?: unknown } =
    value
  return {
    ackOutputSourceRanges: record.ackOutputSourceRanges === 1,
    outputPause: record.outputPause === 1,
    inputAck: record.inputAck === 1
  }
}

export abstract class RemoteRuntimeTerminalResponseController extends RemoteRuntimeTerminalFlowController {
  protected handleResponse(response: RuntimeRpcResponse<unknown>): void {
    if (!this.matchesCurrentEnvironmentRevision()) {
      this.closeForEnvironmentReplacement()
      return
    }
    let event: TerminalMultiplexEvent
    try {
      event = unwrapRuntimeRpcResult(response) as TerminalMultiplexEvent
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if (event.type === 'ready') {
      this.ready = true
      this.resolveReadyIfConnected()
      return
    }

    if (!('streamId' in event) || typeof event.streamId !== 'number') {
      return
    }
    const stream = this.streams.get(event.streamId)
    if (!stream) {
      return
    }
    stream.watchdog.recordInbound(false)
    if (event.type === 'end' && shouldHoldE2eRemoteTerminalEnd(stream.terminal)) {
      return
    }
    if (event.type === 'subscribed') {
      const capabilities = parseSubscribedCapabilities(event.capabilities)
      if (
        capabilities.ackOutputSourceRanges &&
        typeof event.streamGeneration === 'string' &&
        event.streamGeneration.length > 0
      ) {
        stream.acknowledgeOutputSourceRanges = true
        stream.streamGeneration = event.streamGeneration
      }
      stream.supportsOutputPause = capabilities.outputPause
      // Why require the ledger id: without it a runtime restart could not be told apart, and replay would run input twice.
      stream.inputLedgerId =
        capabilities.inputAck &&
        typeof event.inputLedgerId === 'string' &&
        event.inputLedgerId.length > 0
          ? event.inputLedgerId
          : null
      stream.supportsInputAck = stream.inputLedgerId !== null
      if (stream.supportsOutputPause) {
        stream.callbacks.onOutputPauseCapability?.()
      }
    } else if (event.type === 'end') {
      discardOutputAcknowledgements(stream)
      stream.watchdog.dispose()
      clearSnapshot(stream)
      clearResyncTimer(stream)
      rejectPendingSnapshotRequest(stream, 'Remote terminal stream ended.')
      this.streams.delete(event.streamId)
      if (stream.capacityRejected) {
        if (stream.callbacks.onTransportClose) {
          stream.callbacks.onTransportClose({ recoverable: true, retryWithBackoff: true })
        } else {
          stream.callbacks.onError?.(TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR)
        }
      } else {
        stream.callbacks.onEnd?.(parseTerminalStreamEndVerdict(event.verdict))
      }
      this.closeIfIdle()
    } else if (event.type === 'error') {
      const message =
        typeof event.message === 'string' ? event.message : 'Remote terminal stream failed.'
      if (message === TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR) {
        stream.capacityRejected = true
        return
      }
      clearSnapshot(stream)
      rejectPendingSnapshotRequest(stream, message)
      // Why: the paired binary Error frame can be dropped under backpressure;
      // this reliable event must also dispatch or release the resync gate, and
      // must never disarm the watchdog while leaving the gate shut.
      if (stream.resyncPendingSend) {
        this.sendDeferredResyncSnapshot(stream)
      } else {
        clearResyncTimer(stream)
        stream.resyncInFlight = false
      }
      stream.callbacks.onError?.(message)
    } else if (event.type === 'fit-override-changed') {
      if (
        (event.mode !== 'mobile-fit' &&
          event.mode !== 'remote-desktop-fit' &&
          event.mode !== 'desktop-fit') ||
        typeof event.cols !== 'number' ||
        typeof event.rows !== 'number' ||
        // Why: a restarted host that has not learned the grid yet publishes a 0x0 hold; parking
        // xterm there shrinks the pane to one cell, so keys typed into it never reach the shell.
        (event.mode !== 'desktop-fit' && (event.cols <= 0 || event.rows <= 0))
      ) {
        return
      }
      stream.callbacks.onFitOverrideChanged?.({
        mode: event.mode,
        cols: event.cols,
        rows: event.rows
      })
    } else if (event.type === 'driver-changed') {
      if (!isTerminalDriverState(event.driver)) {
        return
      }
      stream.callbacks.onDriverChanged?.(event.driver)
    }
  }
}
