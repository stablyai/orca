import { evaluateRuntimeCompat } from './protocol-compat'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION, RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { RuntimeStatus } from './runtime-types'

export type RemotePairingFailureKind =
  | 'host-unreachable'
  | 'host-identity-mismatch'
  | 'access-link-invalid'
  | 'protocol-incompatible'
  | 'connection-interrupted'
  | 'environment-save-failed'

export type RemotePairingFailure = {
  ok: false
  kind: RemotePairingFailureKind
  message: string
}

export type VerifyAndAddRuntimeEnvironmentResult =
  | {
      ok: true
      environment: PublicKnownRuntimeEnvironment
      runtimeStatus: RuntimeStatus
    }
  | RemotePairingFailure

const RUNTIME_GRAPH_STATUSES = new Set(['ready', 'reloading', 'unavailable'])

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function hasValidRuntimeStatusShape(status: Record<string, unknown>): boolean {
  return (
    typeof status.runtimeId === 'string' &&
    status.runtimeId.length > 0 &&
    isNonNegativeSafeInteger(status.rendererGraphEpoch) &&
    typeof status.graphStatus === 'string' &&
    RUNTIME_GRAPH_STATUSES.has(status.graphStatus) &&
    (status.authoritativeWindowId === null ||
      isNonNegativeSafeInteger(status.authoritativeWindowId)) &&
    isNonNegativeSafeInteger(status.liveTabCount) &&
    isNonNegativeSafeInteger(status.liveLeafCount) &&
    (status.deviceScope === undefined ||
      status.deviceScope === 'mobile' ||
      status.deviceScope === 'runtime') &&
    (status.capabilities === undefined ||
      (Array.isArray(status.capabilities) &&
        status.capabilities.every((capability) => typeof capability === 'string')))
  )
}

export function verifyRemotePairingRuntimeStatus(
  value: unknown
): { ok: true; runtimeStatus: RuntimeStatus } | RemotePairingFailure {
  if (typeof value !== 'object' || value === null) {
    return {
      ok: false,
      kind: 'connection-interrupted',
      message: 'The remote host returned an invalid status response.'
    }
  }
  const status = value as Partial<RuntimeStatus> & Record<string, unknown>
  if (status.deviceScope === 'mobile') {
    return {
      ok: false,
      kind: 'access-link-invalid',
      message: 'This link grants mobile-only access. Generate a link for another Orca client.'
    }
  }
  const versionFields = [
    status.runtimeProtocolVersion,
    status.protocolVersion,
    status.minCompatibleRuntimeClientVersion,
    status.minCompatibleMobileVersion
  ]
  if (
    versionFields.some(
      (version) => version !== undefined && (!Number.isSafeInteger(version) || Number(version) < 0)
    )
  ) {
    return {
      ok: false,
      kind: 'connection-interrupted',
      message: 'The remote host returned an invalid protocol version.'
    }
  }
  const compatibility = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
  if (compatibility.kind === 'blocked') {
    return {
      ok: false,
      kind: 'protocol-incompatible',
      message:
        compatibility.reason === 'client-too-old'
          ? 'Update this Orca client before adding the remote host.'
          : 'Update Orca on the remote host before adding it.'
    }
  }
  if (!hasValidRuntimeStatusShape(status)) {
    return {
      ok: false,
      kind: 'connection-interrupted',
      message: 'The remote host returned an invalid status response.'
    }
  }
  return { ok: true, runtimeStatus: value as RuntimeStatus }
}
