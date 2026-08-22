import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export async function refreshRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs: number,
  publish: (status: RuntimeStatus | null) => void
): Promise<boolean> {
  const expectedEnvironmentRevision = getRuntimeEnvironmentRevision(environmentId)
  try {
    const response = await window.api.runtimeEnvironments.getStatus({
      selector: environmentId,
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentRevision) {
      return false
    }
    publish(status)
    return true
  } catch {
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentRevision) {
      return false
    }
    publish(null)
    return false
  }
}
