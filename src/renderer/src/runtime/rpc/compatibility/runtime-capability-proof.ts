import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '../environment-revisions/runtime-environment-revision'
import { runtimeEnvironmentPairingChangedError } from '../environment-revisions/runtime-environment-pairing-refresh'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  runtimeCompatibilityChecks,
  RUNTIME_CAPABILITY_STATUS_TTL_MS
} from './runtime-compatibility-cache'
import { getRuntimeEnvironmentStatus } from './runtime-compatibility-probe'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../../shared/concurrency/abort-signal-reason'

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number,
  admissionSignal?: AbortSignal
): Promise<boolean> {
  const { supported } = await resolveRuntimeEnvironmentCapabilities(
    environmentId,
    [capability],
    timeoutMs,
    undefined,
    admissionSignal
  )
  return supported[0]
}

export async function runtimeEnvironmentSupportsCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number,
  /** Capabilities whose absence keeps the cached status, so an older host isn't asked again each
   *  read; an upgrade still shows once that status expires. */
  optional: readonly RuntimeCapability[] = []
): Promise<boolean[]> {
  return (
    await resolveRuntimeEnvironmentCapabilities(environmentId, capabilities, timeoutMs, optional)
  ).supported
}

export type RuntimeCapabilityProof = {
  supported: boolean
  runtimeId: string
  pairingRevision: number | undefined
}

/** A capability answer bound to the runtime and pairing that gave it, so a call can be pinned to them. */
export async function runtimeEnvironmentCapabilityProof(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<RuntimeCapabilityProof> {
  const trimmed = environmentId.trim()
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(trimmed)
  const { supported, status } = await resolveRuntimeEnvironmentCapabilities(
    trimmed,
    [capability],
    timeoutMs
  )
  // A re-pair while the status was in flight voids its answer, negative included.
  if (
    resolveContinuedRuntimeEnvironmentRevision(trimmed, pairingRevision) !==
    getRuntimeEnvironmentRevision(trimmed)
  ) {
    throw runtimeEnvironmentPairingChangedError()
  }
  return { supported: supported[0], runtimeId: status.runtimeId, pairingRevision }
}

async function resolveRuntimeEnvironmentCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number,
  optional: readonly RuntimeCapability[] = [],
  admissionSignal?: AbortSignal
): Promise<{ supported: boolean[]; status: RuntimeStatus }> {
  const missesRequired = (supported: readonly boolean[]): boolean =>
    supported.some((ok, index) => !ok && !optional.includes(capabilities[index]!))
  const trimmed = environmentId.trim()
  const cached = runtimeCompatibilityChecks.get(trimmed)
  // Capability reads must discard rejected probes like ordinary RPCs or a recovered host stays blocked until failure TTL.
  if (cached && cached.failedAt === null) {
    try {
      await waitForPromiseWithSignal(cached.check, admissionSignal)
      if (
        runtimeCompatibilityChecks.get(trimmed) === cached &&
        cached.status &&
        cached.statusCheckedAt !== null &&
        Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS
      ) {
        const status = cached.status
        const supported = capabilities.map(
          (capability) => status.capabilities?.includes(capability) === true
        )
        if (missesRequired(supported)) {
          // Keep protocol proof for this legacy call; next capability decision must observe in-place upgrades.
          cached.statusCheckedAt = null
        }
        return { supported, status }
      }
    } catch {
      // Fall through to a fresh status.get that refreshes the cache.
    }
  }
  throwIfSignalAborted(admissionSignal)
  const status = await waitForPromiseWithSignal(
    getRuntimeEnvironmentStatus(trimmed, timeoutMs),
    admissionSignal
  )
  const supported = capabilities.map(
    (capability) => status.capabilities?.includes(capability) === true
  )
  const resolved = runtimeCompatibilityChecks.get(trimmed)
  // Why runtimeId: a status publication may have replaced the entry with its own copy.
  if (missesRequired(supported) && resolved?.status?.runtimeId === status.runtimeId) {
    resolved.statusCheckedAt = null
  }
  return { supported, status }
}

export async function assertRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability,
  message: string,
  timeoutMs?: number
): Promise<void> {
  if (!(await runtimeEnvironmentSupportsCapability(environmentId, capability, timeoutMs))) {
    throw new Error(message)
  }
}
