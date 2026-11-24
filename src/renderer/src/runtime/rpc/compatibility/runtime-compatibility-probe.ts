import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { callRuntimeEnvironmentWithRevision } from '../calls/runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from '../calls/runtime-rpc-result'
import {
  compatibilityEntry,
  getCachedRuntimeCompatibilityCheck,
  rememberRuntimeEnvironmentCompatibility,
  runtimeCompatibilityChecks
} from './runtime-compatibility-cache'
import { RUNTIME_IDLE_STOPPED_ERROR_CODE } from '../../../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-stop-signal'

function isIdleStopRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === RUNTIME_IDLE_STOPPED_ERROR_CODE
  )
}

export async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: {
    timeoutMs?: number
    reuseRecentCompatibilityFailure?: boolean
    expectedEnvironmentPairingRevision?: number
    /** The caller's own wake intent: the probe is what reaches an idle-stopped WSL host first. */
    wake?: boolean
    /** The caller is a poll: its probe must not count as use of an idle host either (#46567). */
    background?: boolean
  } = {}
): Promise<RuntimeStatus | null> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    try {
      await cached.check
      return cached.status
    } catch (error) {
      // A probe that met the idle stop proves nothing about compatibility; a wake probes afresh.
      if (!options.wake || !isIdleStopRefusal(error)) {
        throw error
      }
    }
  }
  const entry = compatibilityEntry()
  const check = (async () => {
    const response = await callRuntimeEnvironmentWithRevision({
      environmentId,
      method: 'status.get',
      params: undefined,
      timeoutMs: options.timeoutMs,
      expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision,
      ...(options.background ? { background: true } : {}),
      wake: options.wake
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
      if (isIdleStopRefusal(error)) {
        // Never a cached verdict: the next user call's wake must probe again.
        runtimeCompatibilityChecks.delete(environmentId)
      } else {
        // Startup repo/group/folder bursts should pay one offline-host timeout, not three.
        entry.failedAt = Date.now()
      }
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
