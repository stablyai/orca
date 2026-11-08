import type { TerminalAttachmentLaunchResult } from '../../../../../shared/terminal/pty/lifecycle/terminal-attachment-launch-result'
import type { TerminalStreamEndVerdict } from '../../../../../shared/terminal/stream/terminal-stream-end-verdict'
import type { TerminalInputAckKind } from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import type {
  RemoteRuntimeSnapshotImage,
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotRequestOptions
} from '../snapshots/remote-terminal-snapshot-contracts'

export type RemoteRuntimeMultiplexedTerminalCallbacks = {
  onData: (data: string, meta?: { seq?: number; rawLength?: number; transformed?: boolean }) => void
  onSnapshot: (
    data: string,
    meta?: {
      pendingEscapeTailAnsi?: string
      seq?: number
      kittyKeyboardFlags?: number
      alternateScreen?: boolean
      terminalOwner?: 'shell'
      /** The host's tracked title when this image was taken; absent from older hosts. */
      lastTitle?: string
      /** Grid the host serialized this image at. Absent from hosts that omit
       *  it, which must read as unknown so replay keeps the pane's own grid. */
      cols?: number
      rows?: number
      /** The host folded history above the screen (scrollbackRows > 0). */
      carriesHistory?: boolean
    }
  ) => void
  onSubscribed?: () => void
  /** The host installed the stream and named its capabilities; its initial snapshot is still on the way. */
  onSubscribeAcknowledged?: (result?: TerminalAttachmentLaunchResult) => void
  onOutputPauseCapability?: () => void
  /** The host discarded output while this stream was paused (negotiated streams only). */
  onPausedOutputDropped?: () => void
  onEnd?: (verdict: TerminalStreamEndVerdict) => void
  onError?: (message: string) => void
  onFitOverrideChanged?: (event: {
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
    cols: number
    rows: number
  }) => void
  onDriverChanged?: (
    driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
  ) => void
  onWriteUnavailable?: () => void
  /** Cumulative host ack of sequenced input through `appliedSeq` (negotiated streams only). */
  onInputAck?: (appliedSeq: number, kind: TerminalInputAckKind) => void
  onTransportClose?: (event: RemoteTerminalTransportCloseEvent) => void
}

export type RemoteTerminalTransportCloseEvent = {
  recoverable: boolean
  retryWithBackoff?: boolean
  /** This stream stopped answering while the shared connection may be healthy. */
  stalled?: true
}

export type RemoteRuntimeMultiplexedTerminal = {
  streamId: number
  /** `inputSeq` is honored only once the host negotiated `inputAck`; see `acknowledgesInput`. */
  sendInput: (text: string, inputSeq?: number) => boolean
  // Why: until the host echoes `inputAck`, delivery of a sent byte is unknown and must never be replayed.
  acknowledgesInput: () => boolean
  /** The host ledger that dedupes this stream's input; a different one has no record of earlier sends. */
  inputLedgerId: () => string | null
  resize: (cols: number, rows: number) => boolean
  claimViewport: (cols: number, rows: number) => boolean
  setOutputPaused: (paused: boolean) => boolean
  // Why: only then does a pause with no drop notice prove nothing was lost.
  reportsPausedOutputDrops?: () => boolean
  serializeBuffer: (
    opts?: RemoteRuntimeSnapshotRequestOptions
  ) => Promise<RemoteRuntimeSnapshotImage | null>
  // Why: same request as serializeBuffer, but keeps the host's reason for an absent buffer instead of collapsing it to null.
  serializeBufferOutcome: (
    opts?: RemoteRuntimeSnapshotRequestOptions
  ) => Promise<RemoteRuntimeSnapshotOutcome>
  close: () => void
}
