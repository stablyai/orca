import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import { runtimeEnvironmentPairingChangedError } from './runtime-environment-pairing-refresh'
import {
  runtimeCompatibilityChecks,
  type RuntimeCompatibilityCacheEntry
} from './runtime-compatibility-cache'
import { getRuntimeEnvironmentCapabilityStatus } from './runtime-rpc-client'

/** A status that lacks a capability is read again by the next capability decision, so an
 *  in-place upgrade is seen; its protocol proof stays for this call. */
export function forgetMissingRuntimeCapability(
  environmentId: string,
  read: { status: RuntimeStatus; entry: RuntimeCompatibilityCacheEntry }
): void {
  const resolved = runtimeCompatibilityChecks.get(environmentId.trim())
  // Why runtimeId: a status publication may have replaced the entry with its own copy.
  if (
    resolved &&
    (resolved === read.entry || resolved.status?.runtimeId === read.status.runtimeId)
  ) {
    resolved.statusCheckedAt = null
  }
}

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<boolean> {
  const [supported] = await runtimeEnvironmentSupportsCapabilities(
    environmentId,
    [capability],
    timeoutMs
  )
  return supported
}

export async function runtimeEnvironmentSupportsCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number
): Promise<boolean[]> {
  return (await resolveRuntimeEnvironmentCapabilities(environmentId, capabilities, timeoutMs))
    .supported
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

/** Every capability decision of one call reads one shared status; a missing one is read again
 *  by the next decision, so an in-place upgrade is seen. */
async function resolveRuntimeEnvironmentCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number
): Promise<{ supported: boolean[]; status: RuntimeStatus }> {
  const read = await getRuntimeEnvironmentCapabilityStatus(environmentId, timeoutMs)
  const supported = capabilities.map(
    (capability) => read.status.capabilities?.includes(capability) === true
  )
  if (supported.includes(false)) {
    forgetMissingRuntimeCapability(environmentId, read)
  }
  return { supported, status: read.status }
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
