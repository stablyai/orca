/** Version negotiated by a source relay and a destination PTY owner. */
export const PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION = 1

/** Hard upper bound for replay and input-dedup state carried by one bridge. */
export const PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES = 128 * 1024
export const PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES = 4 * 1024 * 1024
export const PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS = 4096
export const PTY_OWNERSHIP_BRIDGE_MAX_INPUT_IDS = 65_536

export type PtyOwnershipBridgeCapabilities = Readonly<{
  protocolVersions: readonly number[]
  maxReplayBytes: number
  maxInputIds: number
  inputDeduplication: boolean
  rollback: boolean
  /** True only when the peer exposes prepare/stream/commit/abort transport adapters. */
  liveTransfer: boolean
  /** True when the additive ownership-transfer status RPC is available for recovery probes. */
  statusQuery?: boolean
  /** True only when post-commit output reaches the destination through a lossless route. */
  destinationOutput?: boolean
  /** True only when controls are attachment-fenced and retry-deduplicated. */
  destinationControl?: boolean
  /** True only when host-positive exit evidence is routed to the active destination attachment. */
  authoritativeExit?: boolean
  /** True only when a rekeyed attachment can replay retained post-commit output by cursor. */
  postCommitReplay?: boolean
  /** True only when the source supports monotonic reconnect-route rekeying. */
  reconnectRekey?: boolean
  /** Source capture RPCs are available only with explicit version support. */
  captureBoundaryVersion?: 1
  captureSelectionVersion?: 1
  captureSelectionRecoveryVersion?: 1
  /** Explicit source-delivery retirement, exact boundary, and durable retry support. */
  sourceRetirementVersion?: 1
  sourceRetirementBoundaryVersion?: 1
  sourceRetirementRecoveryVersion?: 1
  /** Resumed source owner can retire exact delivery under committed destination custody. */
  sourceSuccessorRetirementVersion?: 1
  /** Source accepts durable delegated preparation for a host-local destination. */
  destinationDelegationVersion?: 1
  /** New source fences refuse pending host shutdown; not a reconnect/drain guarantee. */
  preparationShutdownGuardVersion?: 1
  /** Automatic grace expiry defers for live transfer fences; not an explicit-shutdown guard. */
  transferGraceGuardVersion?: 1
  /** Lifecycle shutdown defers before disposal; excludes fatal reap and external forced kills. */
  transferLifecycleGuardVersion?: 1
}>

export type PtyOwnershipBridgeHello = Readonly<{
  terminalId: string
  incarnationId: string
  ownerLease: string
  capabilities: PtyOwnershipBridgeCapabilities
}>

export type PtyOwnershipBridgeGrant = Readonly<{
  protocolVersion: typeof PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION
  bridgeId: string
  terminalId: string
  incarnationId: string
  ownerLease: string
  replayBytes: number
  inputIds: number
  inputDeduplication: boolean
  rollback: boolean
  liveTransfer: boolean
  /** Set only when both peers support lossless post-commit destination output. */
  destinationOutput?: boolean
  /** Set only when both peers support attachment-fenced destination controls. */
  destinationControl?: boolean
  /** Set only when both peers provide host-positive exit evidence. */
  authoritativeExit?: boolean
  /** Set only when both peers support attachment-fenced post-commit replay. */
  postCommitReplay?: boolean
  /** Set only when both peers support monotonic reconnect-route rekeying. */
  reconnectRekey?: boolean
}>

export type PtyOwnershipBridgeOutputFrame = Readonly<{
  seq: number
  data: string
  /** True when the source chunk was larger than the replay window and was clipped. */
  truncated?: boolean
}>

export type PtyOwnershipBridgeInputFrame = Readonly<{
  inputId: string
  data: string
}>

export type PtyOwnershipBridgePhase = 'idle' | 'prepared' | 'committed' | 'aborted'

export type PtyOwnershipBridgeSnapshot = Readonly<{
  phase: PtyOwnershipBridgePhase
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOutputEndSeq: number
  destinationOutputEndSeq: number
  stagedOutputFrames: number
  retainedReplayBytes: number
  acceptedInputIds: number
}>
