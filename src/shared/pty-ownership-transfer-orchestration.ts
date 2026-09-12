import type { PtyOwnershipBridgeCapabilities } from './pty-ownership-bridge-contract'
import { parsePtyOwnershipBridgeCapabilities } from './pty-ownership-bridge-validation'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export type PtyOwnershipTransferPreflightRequest = Readonly<{
  /** Null for a PTY owned by the runtime receiving the probe. */
  connectionId: string | null
  ptyId: string
  destinationRuntimeId: string
}>

export type PtyOwnershipTransferPreflightBlocker =
  | 'destination-runtime-mismatch'
  | 'destination-runtime-not-distinct'
  | 'source-not-direct-ssh'
  | 'source-runtime-probe-required'
  | 'source-connection-mismatch'
  | 'source-terminal-untracked'
  | 'source-terminal-incarnation-unavailable'
  | 'source-provider-unavailable'
  | 'source-capabilities-unavailable'
  | 'protocol-version-unsupported'
  | 'input-deduplication-unsupported'
  | 'rollback-unsupported'
  | 'transfer-transport-unavailable'
  | 'live-transfer-disabled'
  | 'destination-output-unsupported'
  | 'post-commit-replay-unsupported'
  | 'destination-control-unsupported'
  | 'authoritative-exit-unsupported'
  | 'production-transfer-disabled'
  | 'destination-adapter-unavailable'

export type PtyOwnershipTransferPreflightResult = Readonly<{
  topology: 'direct-ssh' | 'runtime-owned' | 'paired-runtime-reference'
  transferSupported: boolean
  statusQuerySupported: boolean
  blocker: PtyOwnershipTransferPreflightBlocker | null
  capabilities: PtyOwnershipBridgeCapabilities | null
}>

export type PtyOwnershipTransferStatusProbeRequest = PtyOwnershipTransferPreflightRequest &
  Readonly<{ identity: PtyOwnershipTransferIdentity; timeoutMs?: number }>

/** Explicit desktop invocation of a live direct-SSH transfer. */
export type PtyOwnershipTransferExecuteRequest = Readonly<{
  connectionId: string
  ptyId: string
  destinationRuntimeId: string
  /**
   * Optional legacy hint. Source authority is always resolved by the host from the
   * authenticated owner session; caller-supplied lease/generation/bridge fields are
   * never trusted. New callers should omit this field.
   */
  identity?: PtyOwnershipTransferIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  timeoutMs?: number
}>

/** IPC-safe result; the destination adapter remains runtime-owned. */
export type PtyOwnershipTransferExecuteResult = Readonly<{
  identity: PtyOwnershipTransferIdentity
  commitReceipt: PtyOwnershipTransferCommitReceipt
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
}>

const PREFLIGHT_TOPOLOGIES = new Set<PtyOwnershipTransferPreflightResult['topology']>([
  'direct-ssh',
  'runtime-owned',
  'paired-runtime-reference'
])

const PREFLIGHT_BLOCKERS = new Set<Exclude<PtyOwnershipTransferPreflightBlocker, null>>([
  'destination-runtime-mismatch',
  'destination-runtime-not-distinct',
  'source-not-direct-ssh',
  'source-runtime-probe-required',
  'source-connection-mismatch',
  'source-terminal-untracked',
  'source-terminal-incarnation-unavailable',
  'source-provider-unavailable',
  'source-capabilities-unavailable',
  'protocol-version-unsupported',
  'input-deduplication-unsupported',
  'rollback-unsupported',
  'transfer-transport-unavailable',
  'live-transfer-disabled',
  'destination-output-unsupported',
  'post-commit-replay-unsupported',
  'destination-control-unsupported',
  'authoritative-exit-unsupported',
  'production-transfer-disabled',
  'destination-adapter-unavailable'
])

export function parsePtyOwnershipTransferPreflightResult(
  value: unknown
): PtyOwnershipTransferPreflightResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPreflightResult()
  }
  const record = value as Record<string, unknown>
  const topology = record.topology as PtyOwnershipTransferPreflightResult['topology']
  const blocker = record.blocker as PtyOwnershipTransferPreflightBlocker | null
  const capabilities =
    record.capabilities === null ? null : parsePtyOwnershipBridgeCapabilities(record.capabilities)
  if (
    !PREFLIGHT_TOPOLOGIES.has(topology) ||
    typeof record.transferSupported !== 'boolean' ||
    typeof record.statusQuerySupported !== 'boolean' ||
    (blocker !== null && !PREFLIGHT_BLOCKERS.has(blocker)) ||
    (record.capabilities !== null && capabilities === null) ||
    record.transferSupported !== (blocker === null) ||
    (record.transferSupported && capabilities?.liveTransfer !== true) ||
    (record.statusQuerySupported && capabilities?.statusQuery !== true)
  ) {
    throw invalidPreflightResult()
  }
  return Object.freeze({
    topology,
    transferSupported: record.transferSupported,
    statusQuerySupported: record.statusQuerySupported,
    blocker,
    capabilities
  })
}

function invalidPreflightResult(): Error {
  return new Error('pty_ownership_transfer_preflight_result_invalid')
}
