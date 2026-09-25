import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { e2eDisableRemoteTerminalStallRecovery } from '@/lib/e2e-config'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { RemoteRuntimeTerminalBinaryController } from './remote-runtime-terminal-binary-controller'
import {
  CONTROL_STREAM_ID,
  clearResyncTimer,
  discardOutputAcknowledgements,
  rejectPendingSnapshotRequest
} from './remote-runtime-terminal-snapshot-state'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks,
  RemoteRuntimeMultiplexedTerminalState
} from './remote-runtime-terminal-multiplexer-types'
import { createRemoteTerminalStreamWatchdog } from './remote-terminal-stream-watchdog'

export class RemoteRuntimeTerminalMultiplexer extends RemoteRuntimeTerminalBinaryController {
  async subscribeTerminal(args: {
    terminal: string
    client: { id: string; type: 'desktop' | 'mobile' }
    viewport?: { cols: number; rows: number }
    callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  }): Promise<RemoteRuntimeMultiplexedTerminal> {
    const streamId = this.allocateStreamId()
    const state: RemoteRuntimeMultiplexedTerminalState = {
      streamId,
      terminal: args.terminal,
      callbacks: args.callbacks,
      subscriptionRequested: false,
      acknowledgeOutput: true,
      acknowledgeOutputSourceRanges: false,
      supportsOutputPause: false,
      outputPaused: false,
      streamGeneration: null,
      sourceAckedEndByte: 0,
      heldAckBytes: 0,
      pendingAckBytes: 0,
      ackFlushTimer: null,
      snapshotChunks: [],
      snapshotBytes: 0,
      snapshotOverflowed: false,
      snapshotTarget: 'initial',
      snapshotInfo: null,
      initialSnapshotReceived: false,
      pendingSnapshotRequest: null,
      expectedSeq: undefined,
      commandProbeBaselineSeq: undefined,
      recoverySnapshotSeq: undefined,
      resyncInFlight: false,
      resyncPendingSend: false,
      resyncTimer: null,
      resyncAttempts: 0,
      capacityRejected: false,
      watchdog: createRemoteTerminalStreamWatchdog((stall) => {
        if (e2eDisableRemoteTerminalStallRecovery) {
          state.watchdog.completeCommandResponseProbe()
          return
        }
        recordRendererCrashBreadcrumb('remote_terminal_stream_stall_recovery', {
          environmentId: this.environmentId,
          expectedSeq: state.expectedSeq ?? null,
          inactiveForMs: stall.inactiveForMs,
          outstandingDeliveryBytes: stall.outstandingDeliveryBytes,
          pendingAckBytes: state.pendingAckBytes,
          reason: stall.reason,
          resyncAttempts: state.resyncAttempts,
          snapshotPending: state.pendingSnapshotRequest !== null,
          streamId: state.streamId,
          terminal: state.terminal
        })
        if (stall.reason === 'command-response-timeout') {
          this.probeCommandResponse(state)
        } else {
          this.recoverStalledStream(state)
        }
      })
    }
    this.streams.set(streamId, state)

    const stream: RemoteRuntimeMultiplexedTerminal = {
      streamId,
      sendInput: (text) => this.isRegisteredStream(state) && this.sendInput(state, text),
      resize: (cols, rows) =>
        this.isRegisteredStream(state) &&
        this.sendFrame(
          streamId,
          TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson({ cols, rows })
        ),
      claimViewport: (cols, rows) => {
        if (!this.isRegisteredStream(state)) {
          return false
        }
        const claimed = this.sendFrame(
          streamId,
          TerminalStreamOpcode.ClaimViewport,
          encodeTerminalStreamJson({ cols, rows })
        )
        // Why: older runtimes ignore the claim opcode but still understand
        // Resize. Claim first keeps new-runtime ownership precise and leaves a
        // backwards-compatible resize immediately behind it.
        const resized = this.sendFrame(
          streamId,
          TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson({ cols, rows })
        )
        return claimed && resized
      },
      setOutputPaused: (paused) => this.setOutputPaused(state, paused),
      serializeBuffer: (opts) => this.requestSnapshot(state, opts),
      serializeBufferOutcome: (opts) => this.requestSnapshotOutcome(state, opts),
      close: () => {
        if (this.streams.get(streamId) === state) {
          discardOutputAcknowledgements(state)
          state.watchdog.dispose()
          this.sendFrame(streamId, TerminalStreamOpcode.Unsubscribe)
          clearResyncTimer(state)
          rejectPendingSnapshotRequest(state, 'Remote terminal stream closed.')
          this.streams.delete(streamId)
          this.closeIfIdle()
        }
      }
    }

    try {
      await this.ensureConnected()
      if (this.streams.get(streamId) !== state) {
        return stream
      }
      const sent = this.sendFrame(
        CONTROL_STREAM_ID,
        TerminalStreamOpcode.Subscribe,
        encodeTerminalStreamJson({
          streamId,
          terminal: args.terminal,
          client: args.client,
          viewport: args.viewport,
          capabilities: {
            ackOutput: 1,
            ackOutputSourceRanges: 1,
            outputPause: 1,
            writeUnavailable: 1,
            ...(args.client.type === 'desktop' ? { desktopViewportClaims: 1 } : {})
          }
        })
      )
      if (!sent) {
        throw new Error('Remote terminal stream is not connected.')
      }
      state.subscriptionRequested = true
    } catch (error) {
      const terminalError = error instanceof Error ? error : new Error(String(error))
      if (this.streams.get(streamId) === state) {
        this.streams.delete(streamId)
        this.closeIfIdle()
      }
      throw terminalError
    }

    return stream
  }
}
