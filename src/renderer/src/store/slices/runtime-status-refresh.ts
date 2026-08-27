import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

/** `superseded` means the environment was re-paired mid-probe: the answer describes a
 * retired pairing, so it is evidence about neither this host's reachability nor its state. */
export type RuntimeStatusRefreshOutcome = 'reachable' | 'unreachable' | 'superseded'

export async function refreshRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs: number,
  publish: (status: RuntimeStatus | null) => void
): Promise<RuntimeStatusRefreshOutcome> {
  const expectedEnvironmentRevision = getRuntimeEnvironmentRevision(environmentId)
  try {
    const response = await window.api.runtimeEnvironments.getStatus({
      selector: environmentId,
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentRevision) {
      return 'superseded'
    }
    publish(status)
    return 'reachable'
  } catch {
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentRevision) {
      return 'superseded'
    }
    publish(null)
    return 'unreachable'
  }
}
