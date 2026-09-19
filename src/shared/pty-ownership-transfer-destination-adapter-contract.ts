import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferDestinationJournal,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type {
  PtyOwnershipTransferExecutionVerdict,
  PtyOwnershipTransferExit
} from './pty-ownership-transfer-control-wire'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferSurfacePublication,
  PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES = 16 * 1024
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES = 4 * 1024 * 1024
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_DEFAULT_INPUT_IDS = 4_096
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS = 65_536

export class PtyOwnershipTransferDestinationError extends Error {
  constructor(
    readonly reason:
      | 'invalid-request'
      | 'identity-mismatch'
      | 'invalid-phase'
      | 'output-gap'
      | 'output-conflict'
      | 'destination-not-caught-up'
      | 'input-conflict'
      | 'input-deduplication-window-exhausted'
      | 'receipt-invalid'
      | 'publication-invalid'
      | 'surface-unbound'
      | 'surface-conflict'
      | 'stale-attachment'
      | 'exit-conflict',
    message: string
  ) {
    super(message)
    this.name = 'PtyOwnershipTransferDestinationError'
  }
}

/** Durable destination operations. Frame append + cursor update must be atomic. */
export type PtyOwnershipTransferDestinationStore = Readonly<{
  load: (identity: PtyOwnershipTransferIdentity) => PtyOwnershipTransferDestinationJournal | null
  prepare: (
    identity: PtyOwnershipTransferIdentity,
    acceptedSourceEndSeq: number
  ) => PtyOwnershipTransferDestinationJournal
  loadFrames: (identity: PtyOwnershipTransferIdentity) => readonly PtyOwnershipTransferOutputFrame[]
  appendFrame: (
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ) => PtyOwnershipTransferDestinationJournal
  commit: (
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt
  ) => PtyOwnershipTransferDestinationJournal
  loadSurfaceBinding: (
    identity: PtyOwnershipTransferIdentity
  ) => PtyOwnershipTransferSurfaceBinding | null
  bindSurface: (
    identity: PtyOwnershipTransferIdentity,
    binding: PtyOwnershipTransferSurfaceBinding
  ) => PtyOwnershipTransferSurfaceBinding
  reservePublication: (
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt
  ) => PtyOwnershipTransferPublicationReceipt
  publish: (
    identity: PtyOwnershipTransferIdentity,
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
  ) => PtyOwnershipTransferDestinationJournal
  abort: (identity: PtyOwnershipTransferIdentity) => PtyOwnershipTransferDestinationJournal
  loadInputIds: (
    identity: PtyOwnershipTransferIdentity
  ) => readonly Readonly<{ inputId: string; data: string }>[]
  acceptInput: (
    identity: PtyOwnershipTransferIdentity,
    inputId: string,
    data: string
  ) => 'accepted' | 'duplicate' | 'conflict'
  retireInput: (identity: PtyOwnershipTransferIdentity, inputIds: readonly string[]) => number
}>

export type PtyOwnershipTransferDestinationPublicationRequest = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  frames: readonly PtyOwnershipTransferOutputFrame[]
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
}>

export type PtyOwnershipTransferDestinationAdapterOptions = Readonly<{
  store: PtyOwnershipTransferDestinationStore
  /** Must atomically publish the exact staged output/model binding before returning the receipt. */
  publishDurably: (
    request: PtyOwnershipTransferDestinationPublicationRequest
  ) => PtyOwnershipTransferPublicationReceipt
  /** Must durably route each post-commit frame and tolerate an idempotent retry. */
  publishPostCommitOutput: (
    identity: PtyOwnershipTransferWireIdentity,
    surfaceBinding: PtyOwnershipTransferSurfaceBinding,
    frame: PtyOwnershipTransferOutputFrame
  ) => void
  /** Optional durable baseline hook used by acknowledged post-commit sinks. */
  markPostCommitOutputBaseline?: (
    identity: PtyOwnershipTransferWireIdentity,
    throughSeq: number
  ) => void
  inputIds?: number
}>

export type PtyOwnershipTransferDestinationSnapshot = Readonly<{
  delegatedClaim?: PtyOwnershipTransferDestinationClaim
  delegatedClaimActive?: boolean
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  identity: PtyOwnershipTransferWireIdentity
  sourceOutputEndSeq: number
  acceptedSourceEndSeq: number
  stagedOutputFrames: number
  stagedOutputBytes: number
  acceptedInputIds: number
  liveOutputEndSeq: number
  surfaceBinding?: PtyOwnershipTransferSurfaceBinding
  commitReceipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
  attachmentId?: string
  attachmentGeneration?: number
  executionVerdict: PtyOwnershipTransferExecutionVerdict
  exit?: PtyOwnershipTransferExit
}>

/** Opaque single-use authority for one destination attachment attempt. */
export type PtyOwnershipTransferDestinationAttachmentReservation = Readonly<{
  bridgeId: string
  destinationRuntimeId: string
  attachmentId: string
  generation: number
}>

export type DestinationRecord = {
  delegatedClaim?: PtyOwnershipTransferDestinationClaim
  delegatedClaimActive?: boolean
  identity: PtyOwnershipTransferWireIdentity
  phase: PtyOwnershipTransferDestinationSnapshot['phase']
  sourceOutputEndSeq: number
  replayStartSeq: number
  acceptedSourceEndSeq: number
  stagedFrames: Map<number, PtyOwnershipTransferOutputFrame>
  stagedOutputBytes: number
  acceptedInputIds: Map<string, string>
  commitReceipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
  surfaceBinding?: PtyOwnershipTransferSurfaceBinding
  surfacePublication?: PtyOwnershipTransferSurfacePublication
  liveOutputEndSeq: number
  attachmentId?: string
  attachmentGeneration?: number
  nextAttachmentGeneration: number
  pendingAttachment?: PtyOwnershipTransferDestinationAttachmentReservation
  executionVerdict: PtyOwnershipTransferExecutionVerdict
  exit?: PtyOwnershipTransferExit
}

export type DestinationAdapterState = {
  readonly options: PtyOwnershipTransferDestinationAdapterOptions
  readonly inputIds: number
  record: DestinationRecord | null
}
