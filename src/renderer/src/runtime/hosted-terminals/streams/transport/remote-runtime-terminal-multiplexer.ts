import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { TerminalOutputCadence } from '../../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { e2eDisableRemoteTerminalStallRecovery } from '@/app-shell/startup/e2e-config'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { RemoteRuntimeTerminalBinaryController } from '../frames/remote-runtime-terminal-binary-controller'
import { CONTROL_STREAM_ID } from '../frames/remote-terminal-multiplex-event'
import { disposeRemoteTerminalStreamState } from '../remote-terminal-stream-disposal'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks
} from '../remote-terminal-stream-contracts'
import type { RemoteRuntimeMultiplexedTerminalState } from '../remote-terminal-stream-state'
import { createRemoteTerminalStreamWatchdog } from '../recovery/remote-terminal-stream-watchdog'
import { translate } from '@/i18n/i18n'

export class RemoteRuntimeTerminalMultiplexer extends RemoteRuntimeTerminalBinaryController {
  async subscribeTerminal(args: {
    terminal: string
    client: { id: string; type: 'desktop' | 'mobile' }
    viewport?: { cols: number; rows: number }
    /** Stable across this pane's reattaches so the host can dedupe replayed input. */
    inputSessionId?: string
    /** A terminal pane pauses output while hidden, so the host may count it as showing the terminal. */
    reportsPaneVisibility?: boolean
    /** Set by callers that retune cadence via setOutputCadence; absent leaves the capability unadvertised. */
    outputCadence?: TerminalOutputCadence
    callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  }): Promise<RemoteRuntimeMultiplexedTerminal> {
    const streamId = this.allocateStreamId()
    const outputCadence = args.outputCadence ?? 'focused'
    const state: RemoteRuntimeMultiplexedTerminalState = {
      streamId,
      terminal: args.terminal,
      callbacks: args.callbacks,
      subscriptionRequested: false,
      acknowledgeOutput: true,
      acknowledgeOutputSourceRanges: false,
      supportsOutputPause: false,
      supportsPausedOutputDropNotice: false,
      pausedOutputGapExpected: false,
      supportsInputAck: false,
      inputLedgerId: null,
      outputPaused: false,
      supportsOutputCadence: false,
      outputCadence,
      hostOutputCadence: outputCadence,
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
      resyncUnansweredTimeouts: 0,
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
      sendInput: (text, inputSeq) =>
        this.isRegisteredStream(state) && this.sendInput(state, text, inputSeq),
      acknowledgesInput: () => this.isRegisteredStream(state) && state.supportsInputAck,
      inputLedgerId: () => (this.isRegisteredStream(state) ? state.inputLedgerId : null),
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
        // Claim then Resize: new hosts get precise ownership; older hosts ignore Claim but retain compatible resize.
        const resized = this.sendFrame(
          streamId,
          TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson({ cols, rows })
        )
        return claimed && resized
      },
      setOutputPaused: (paused) => this.setOutputPaused(state, paused),
      setOutputCadence: (cadence) => this.setOutputCadence(state, cadence),
      reportsPausedOutputDrops: () =>
        this.isRegisteredStream(state) && state.supportsPausedOutputDropNotice,
      serializeBuffer: (opts) => this.requestSnapshot(state, opts),
      serializeBufferOutcome: (opts) => this.requestSnapshotOutcome(state, opts),
      close: () => {
        if (this.isRegisteredStream(state)) {
          // Why after: a failed write closes the transport, whose message the pending snapshot must carry.
          this.sendFrame(streamId, TerminalStreamOpcode.Unsubscribe)
          disposeRemoteTerminalStreamState(
            state,
            translate('auto.runtime.remoteTerminal.streamClosed', 'Remote terminal stream closed.')
          )
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
            outputPauseDropNotice: 1,
            ...(args.reportsPaneVisibility ? { paneVisibility: 1 } : {}),
            writeUnavailable: 1,
            ...(args.client.type === 'desktop'
              ? { desktopViewportClaims: 1, endpointLossNotice: 1 }
              : {}),
            ...(args.inputSessionId ? { inputAck: 1 } : {}),
            ...(args.outputCadence ? { outputCadence: 1 } : {})
          },
          ...(args.inputSessionId ? { inputSessionId: args.inputSessionId } : {}),
          ...(outputCadence !== 'focused' ? { outputCadence } : {})
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
