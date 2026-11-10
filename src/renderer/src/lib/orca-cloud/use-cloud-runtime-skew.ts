import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import { evaluateCloudRuntimeSkew, type CloudRuntimeSkew } from './cloud-runtime-skew'

const STATUS_TIMEOUT_MS = 10_000
/** A sandbox keeps its orcad across sleep and restart, so one answer holds for a long while. */
const SKEW_TTL_MS = 30 * 60_000
const RETRIES = 3
const RETRY_DELAY_MS = 5_000

const checked = new Map<string, { skew: CloudRuntimeSkew; at: number }>()
const inFlight = new Map<string, Promise<CloudRuntimeSkew | null>>()
/** Workspaces whose skew notice was dismissed this app session (it comes back after a relaunch). */
const dismissed = new Set<string>()

/**
 * Reads status.get straight from the sandbox, outside the RPC compatibility gate (which throws on
 * exactly the skew this reports). Null when the sandbox doesn't answer: unknown is not skew.
 */
export function checkCloudRuntimeSkew(
  environmentId: string,
  now: number = Date.now()
): Promise<CloudRuntimeSkew | null> {
  const cached = checked.get(environmentId)
  if (cached && now - cached.at < SKEW_TTL_MS) {
    return Promise.resolve(cached.skew)
  }
  const running = inFlight.get(environmentId)
  if (running) {
    return running
  }
  const check = window.api.runtimeEnvironments
    .call({ selector: environmentId, method: 'status.get', timeoutMs: STATUS_TIMEOUT_MS })
    .then((response) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get answers RuntimeStatus; every field read here is optional and range-checked.
      const status = unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeStatus>)
      const skew = evaluateCloudRuntimeSkew(status)
      checked.set(environmentId, { skew, at: Date.now() })
      if (skew.kind !== 'compatible') {
        // Builds and protocols are support details: logged here, never shown in the notice.
        console.warn('[orca-cloud] version skew', { environmentId, ...skew })
      }
      return skew
    })
    .catch(() => null)
    .finally(() => inFlight.delete(environmentId))
  inFlight.set(environmentId, check)
  return check
}

/** "Running" can flip before orcad answers: a few spaced tries instead of never checking. */
async function checkWithRetries(
  environmentId: string,
  isCancelled: () => boolean
): Promise<CloudRuntimeSkew | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await checkCloudRuntimeSkew(environmentId)
    if (result || attempt >= RETRIES || isCancelled()) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }
}

export function resetCloudRuntimeSkewForTests(): void {
  checked.clear()
  inFlight.clear()
  dismissed.clear()
}

/**
 * The skew between this desktop and the workspace's sandbox, checked once it is running. Null
 * while unknown, when compatible, or after the person dismissed the notice.
 */
export function useCloudRuntimeSkew(
  workspaceId: string,
  running: boolean
): { skew: Exclude<CloudRuntimeSkew, { kind: 'compatible' }> | null; dismiss: () => void } {
  const environmentId = useAppStore((state) => {
    const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
    return owner.kind === 'resolved' ? owner.environmentId : null
  })
  // Keyed by environment: a re-pair or a stop never shows the previous environment's verdict.
  const [answer, setAnswer] = useState<{ environmentId: string; skew: CloudRuntimeSkew } | null>(
    null
  )
  const [isDismissed, setDismissed] = useState(() => dismissed.has(workspaceId))
  useEffect(() => {
    if (!running || !environmentId || isDismissed) {
      return
    }
    let cancelled = false
    void checkWithRetries(environmentId, () => cancelled).then((result) => {
      if (!cancelled && result) {
        setAnswer({ environmentId, skew: result })
      }
    })
    return () => {
      cancelled = true
    }
  }, [running, environmentId, isDismissed])
  const dismiss = useCallback(() => {
    dismissed.add(workspaceId)
    setDismissed(true)
  }, [workspaceId])
  const skew =
    running && !isDismissed && answer && answer.environmentId === environmentId ? answer.skew : null
  return {
    skew: skew && skew.kind !== 'compatible' ? skew : null,
    dismiss
  }
}
