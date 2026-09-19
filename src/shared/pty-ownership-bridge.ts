import { randomUUID } from 'node:crypto'
import {
  PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
  PTY_OWNERSHIP_BRIDGE_MAX_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES,
  type PtyOwnershipBridgeGrant,
  type PtyOwnershipBridgeHello,
  type PtyOwnershipBridgeInputFrame,
  type PtyOwnershipBridgeOutputFrame,
  type PtyOwnershipBridgeSnapshot
} from './pty-ownership-bridge-contract'
import {
  assertPtyOwnershipBridgeHello,
  boundedPtyOwnershipBridgeMinimum,
  commonPtyOwnershipBridgeProtocolVersion,
  isPtyOwnershipBridgeCapabilities,
  parsePtyOwnershipBridgeCapabilities
} from './pty-ownership-bridge-validation'
import {
  appendPtyOwnershipBridgeOutput,
  acceptPtyOwnershipBridgeOutput,
  replayPtyOwnershipBridgeOutput
} from './pty-ownership-bridge-output'
import {
  acceptPtyOwnershipBridgeInput,
  retirePtyOwnershipBridgeInputIds
} from './pty-ownership-bridge-input'
import {
  abortPtyOwnershipBridge,
  commitPtyOwnershipBridge,
  snapshotPtyOwnershipBridge
} from './pty-ownership-bridge-lifecycle'
import {
  assertPtyOwnershipBridgeRole,
  type PtyOwnershipBridgeRole
} from './pty-ownership-bridge-role'
import {
  createPtyOwnershipBridgeState,
  type BridgeOptions,
  type PtyOwnershipBridgeState
} from './pty-ownership-bridge-state'
import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'

export {
  PtyOwnershipBridgeError,
  isPtyOwnershipBridgeCapabilities,
  parsePtyOwnershipBridgeCapabilities
}
export type { PtyOwnershipBridgeRole }

/** Transactional source/destination bridge for one live PTY. */
export class PtyOwnershipBridge {
  readonly grant: PtyOwnershipBridgeGrant
  private readonly state: PtyOwnershipBridgeState

  private constructor(
    readonly terminalId: string,
    readonly incarnationId: string,
    readonly ownerLease: string,
    grant: PtyOwnershipBridgeGrant,
    options: BridgeOptions
  ) {
    this.grant = Object.freeze(grant)
    this.state = createPtyOwnershipBridgeState(grant, options)
  }

  /** Negotiate one bridge and fail closed when either side cannot preserve its invariants. */
  static negotiate(
    source: PtyOwnershipBridgeHello,
    destination: PtyOwnershipBridgeHello,
    options: BridgeOptions = {}
  ): PtyOwnershipBridge | null {
    assertPtyOwnershipBridgeHello(source)
    assertPtyOwnershipBridgeHello(destination)
    if (
      source.terminalId !== destination.terminalId ||
      source.incarnationId !== destination.incarnationId ||
      source.ownerLease !== destination.ownerLease
    ) {
      throw new PtyOwnershipBridgeError(
        'identity-mismatch',
        'PTY ownership bridge identities do not match'
      )
    }
    const protocolVersion = commonPtyOwnershipBridgeProtocolVersion(
      source.capabilities.protocolVersions,
      destination.capabilities.protocolVersions
    )
    if (
      !protocolVersion ||
      !source.capabilities.inputDeduplication ||
      !destination.capabilities.inputDeduplication ||
      !source.capabilities.rollback ||
      !destination.capabilities.rollback ||
      !source.capabilities.liveTransfer ||
      !destination.capabilities.liveTransfer ||
      !source.capabilities.destinationOutput ||
      !destination.capabilities.destinationOutput
    ) {
      return null
    }
    const replayBytes = boundedPtyOwnershipBridgeMinimum(
      options.replayBytes ?? PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
      source.capabilities.maxReplayBytes,
      destination.capabilities.maxReplayBytes,
      PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES
    )
    const inputIds = boundedPtyOwnershipBridgeMinimum(
      options.inputIds ?? PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
      source.capabilities.maxInputIds,
      destination.capabilities.maxInputIds,
      PTY_OWNERSHIP_BRIDGE_MAX_INPUT_IDS
    )
    const bridgeId = (options.createBridgeId ?? randomUUID)()
    if (!bridgeId) {
      throw new PtyOwnershipBridgeError('invalid-capabilities', 'bridge ID must be non-empty')
    }
    return new PtyOwnershipBridge(
      source.terminalId,
      source.incarnationId,
      source.ownerLease,
      {
        protocolVersion,
        bridgeId,
        terminalId: source.terminalId,
        incarnationId: source.incarnationId,
        ownerLease: source.ownerLease,
        replayBytes,
        inputIds,
        inputDeduplication: true,
        rollback: true,
        liveTransfer: true,
        destinationOutput: true,
        ...(source.capabilities.destinationControl && destination.capabilities.destinationControl
          ? { destinationControl: true }
          : {}),
        ...(source.capabilities.authoritativeExit && destination.capabilities.authoritativeExit
          ? { authoritativeExit: true }
          : {}),
        ...(source.capabilities.postCommitReplay && destination.capabilities.postCommitReplay
          ? { postCommitReplay: true }
          : {}),
        ...(source.capabilities.reconnectRekey && destination.capabilities.reconnectRekey
          ? { reconnectRekey: true }
          : {})
      },
      { replayBytes, inputIds }
    )
  }

  prepare(role: PtyOwnershipBridgeRole): PtyOwnershipBridgeSnapshot {
    assertPtyOwnershipBridgeRole(role)
    if (role !== 'source') {
      throw new PtyOwnershipBridgeError(
        'identity-mismatch',
        'only the source can prepare a transfer'
      )
    }
    if (this.state.phase === 'prepared') {
      return this.snapshot()
    }
    if (this.state.phase !== 'idle' && this.state.phase !== 'aborted') {
      throw new PtyOwnershipBridgeError('invalid-phase', `cannot prepare from ${this.state.phase}`)
    }
    this.state.phase = 'prepared'
    return this.snapshot()
  }

  appendOutput(role: PtyOwnershipBridgeRole, data: string): PtyOwnershipBridgeOutputFrame {
    assertPtyOwnershipBridgeRole(role)
    return appendPtyOwnershipBridgeOutput(this.state, role, data)
  }

  replayAfter(
    role: PtyOwnershipBridgeRole,
    afterSeq: number
  ): readonly PtyOwnershipBridgeOutputFrame[] {
    assertPtyOwnershipBridgeRole(role)
    return replayPtyOwnershipBridgeOutput(this.state, role, afterSeq)
  }

  acceptOutput(role: PtyOwnershipBridgeRole, frame: PtyOwnershipBridgeOutputFrame): void {
    assertPtyOwnershipBridgeRole(role)
    acceptPtyOwnershipBridgeOutput(this.state, role, frame)
  }

  acceptInput(
    role: PtyOwnershipBridgeRole,
    frame: PtyOwnershipBridgeInputFrame,
    write: (data: string) => void
  ): { accepted: boolean; duplicate: boolean } {
    assertPtyOwnershipBridgeRole(role)
    return acceptPtyOwnershipBridgeInput(
      this.state,
      role,
      frame,
      write,
      this.grant.inputDeduplication
    )
  }

  retireInputIds(role: PtyOwnershipBridgeRole, inputIds: readonly string[]): number {
    assertPtyOwnershipBridgeRole(role)
    return retirePtyOwnershipBridgeInputIds(this.state, role, inputIds)
  }

  commit(role: PtyOwnershipBridgeRole): readonly PtyOwnershipBridgeOutputFrame[] {
    assertPtyOwnershipBridgeRole(role)
    return commitPtyOwnershipBridge(this.state, role)
  }

  abort(role: PtyOwnershipBridgeRole): void {
    assertPtyOwnershipBridgeRole(role)
    abortPtyOwnershipBridge(this.state, role)
  }

  snapshot(): PtyOwnershipBridgeSnapshot {
    return snapshotPtyOwnershipBridge(
      this.state,
      this.terminalId,
      this.incarnationId,
      this.ownerLease
    )
  }
}
