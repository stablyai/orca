import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { callRuntimeEnvironmentWithRevision } from '../calls/runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from '../calls/runtime-rpc-result'
import {
  compatibilityEntry,
  getCachedRuntimeCompatibilityCheck,
  rememberRuntimeEnvironmentCompatibility,
  runtimeCompatibilityChecks
} from './runtime-compatibility-cache'

export async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: {
    timeoutMs?: number
    reuseRecentCompatibilityFailure?: boolean
    expectedEnvironmentPairingRevision?: number
  } = {}
): Promise<RuntimeStatus | null> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    await cached.check
    return cached.status
  }
  const entry = compatibilityEntry()
  const check = (async () => {
    const response = await callRuntimeEnvironmentWithRevision({
      environmentId,
      method: 'status.get',
      params: undefined,
      timeoutMs: options.timeoutMs,
      expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.statusObservedAt = entry.statusCheckedAt
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(environmentId, entry)
  try {
    await check
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      entry.provenCompatible = true
    }
    return entry.status
  } catch (error) {
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      // Startup repo/group/folder bursts should pay one offline-host timeout, not three.
      entry.failedAt = Date.now()
    }
    throw error
  }
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number
): Promise<RuntimeStatus> {
  const trimmed = environmentId.trim()
  const entry = compatibilityEntry()
  // Publish before awaiting so concurrent cold capability reads share this status probe.
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: trimmed,
      method: 'status.get',
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.statusObservedAt = entry.statusCheckedAt
    entry.provenCompatible = true
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
  try {
    await check
  } catch (error) {
    // Always-refetched probe failures must not remain cached verdicts; let next call retry.
    if (runtimeCompatibilityChecks.get(trimmed) === entry) {
      runtimeCompatibilityChecks.delete(trimmed)
    }
    throw error
  }
  if (!entry.status) {
    // Unreachable: a resolved probe always assigns status; narrows the type.
    throw new Error('Runtime status probe resolved without a status.')
  }
  return entry.status
}
