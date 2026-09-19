import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferReplayResult
} from './pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'
import type {
  DestinationAdapterState,
  PtyOwnershipTransferDestinationAttachmentReservation,
  PtyOwnershipTransferDestinationAdapterOptions,
  PtyOwnershipTransferDestinationSnapshot
} from './pty-ownership-transfer-destination-adapter-contract'
import {
  acceptDestinationInput,
  retireDestinationInput
} from './pty-ownership-transfer-destination-adapter-input'
import {
  abortDestinationTransfer,
  acceptDestinationPostCommitOutput,
  bindDestinationSurface,
  commitDestinationTransfer,
  publishDestinationTransfer
} from './pty-ownership-transfer-destination-adapter-lifecycle'
import {
  acceptDestinationReplay,
  acceptDestinationReplayFrame,
  prepareDestinationTransfer,
  snapshotDestinationTransfer
} from './pty-ownership-transfer-destination-adapter-replay'
import { createDestinationAdapterState } from './pty-ownership-transfer-destination-adapter-state'
import type {
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferExitEvent
} from './pty-ownership-transfer-control-wire'
import {
  acceptDestinationExit,
  bindDelegatedDestinationExecution,
  markDelegatedDestinationExecutionUnverifiable,
  acceptDelegatedDestinationExecutionStatus,
  attachDestinationExecution,
  markDestinationExecutionUnverifiable,
  reserveDestinationExecutionAttachment
} from './pty-ownership-transfer-destination-adapter-routing'
import { restoreDestinationPostCommitOutputBaseline } from './pty-ownership-transfer-destination-adapter-lifecycle'

export {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES,
  PtyOwnershipTransferDestinationError
} from './pty-ownership-transfer-destination-adapter-contract'
export type {
  PtyOwnershipTransferDestinationAttachmentReservation,
  PtyOwnershipTransferDestinationAdapterOptions,
  PtyOwnershipTransferDestinationPublicationRequest,
  PtyOwnershipTransferDestinationSnapshot,
  PtyOwnershipTransferDestinationStore
} from './pty-ownership-transfer-destination-adapter-contract'
export type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

/** Destination staging coordinator with durable, retry-safe phase transitions. */
export class PtyOwnershipTransferDestinationAdapter {
  private readonly state: DestinationAdapterState

  constructor(options: PtyOwnershipTransferDestinationAdapterOptions) {
    this.state = createDestinationAdapterState(options)
  }

  prepare(result: PtyOwnershipTransferPrepareResult): PtyOwnershipTransferDestinationSnapshot {
    return prepareDestinationTransfer(this.state, result)
  }

  acceptReplay(result: PtyOwnershipTransferReplayResult): PtyOwnershipTransferDestinationSnapshot {
    return acceptDestinationReplay(this.state, result)
  }

  acceptReplayFrame(
    frame: PtyOwnershipTransferOutputFrame
  ): PtyOwnershipTransferDestinationSnapshot {
    return acceptDestinationReplayFrame(this.state, frame)
  }

  commit(receipt: PtyOwnershipTransferCommitReceipt): PtyOwnershipTransferDestinationSnapshot {
    return commitDestinationTransfer(this.state, receipt)
  }

  bindSurface(
    binding: PtyOwnershipTransferSurfaceBinding
  ): PtyOwnershipTransferDestinationSnapshot {
    return bindDestinationSurface(this.state, binding)
  }

  publish(): PtyOwnershipTransferPublicationReceipt {
    return publishDestinationTransfer(this.state)
  }

  acceptPostCommitOutput(frame: PtyOwnershipTransferOutputFrame): void {
    acceptDestinationPostCommitOutput(this.state, frame)
  }

  acceptPostCommitReplayOutput(
    frame: PtyOwnershipTransferOutputFrame,
    reservation: PtyOwnershipTransferDestinationAttachmentReservation
  ): void {
    acceptDestinationPostCommitOutput(this.state, frame, reservation)
  }

  /** Restore the durable post-commit cursor after a destination-runtime restart. */
  restorePostCommitOutputBaseline(throughSeq: number): PtyOwnershipTransferDestinationSnapshot {
    return restoreDestinationPostCommitOutputBaseline(this.state, throughSeq)
  }

  acceptInput(inputId: string, data: string): { accepted: boolean; duplicate: boolean } {
    return acceptDestinationInput(this.state, inputId, data)
  }

  retireInput(inputIds: readonly string[]): number {
    return retireDestinationInput(this.state, inputIds)
  }

  attachExecution(
    result: PtyOwnershipTransferAttachmentResult,
    reservation: PtyOwnershipTransferDestinationAttachmentReservation
  ): PtyOwnershipTransferDestinationSnapshot {
    return attachDestinationExecution(this.state, result, reservation)
  }

  reserveExecutionAttachment(
    attachmentId: string
  ): PtyOwnershipTransferDestinationAttachmentReservation {
    return reserveDestinationExecutionAttachment(this.state, attachmentId)
  }

  markExecutionUnverifiable(attachmentId: string): PtyOwnershipTransferDestinationSnapshot {
    return markDestinationExecutionUnverifiable(this.state, attachmentId)
  }

  acceptExit(event: PtyOwnershipTransferExitEvent): PtyOwnershipTransferDestinationSnapshot {
    return acceptDestinationExit(this.state, event)
  }

  bindDelegatedExecution(claim: unknown): PtyOwnershipTransferDestinationSnapshot {
    return bindDelegatedDestinationExecution(this.state, claim)
  }

  markDelegatedExecutionUnverifiable(claim: unknown): PtyOwnershipTransferDestinationSnapshot {
    return markDelegatedDestinationExecutionUnverifiable(this.state, claim)
  }

  acceptDelegatedExecutionStatus(status: unknown): PtyOwnershipTransferDestinationSnapshot {
    return acceptDelegatedDestinationExecutionStatus(this.state, status)
  }

  abort(): PtyOwnershipTransferDestinationSnapshot {
    return abortDestinationTransfer(this.state)
  }

  snapshot(): PtyOwnershipTransferDestinationSnapshot {
    return snapshotDestinationTransfer(this.state)
  }
}
