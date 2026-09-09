import type { RuntimeEnvironmentStatus } from './runtime-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { extractRuntimeTransportDiagnostics } from '@/runtime/runtime-status-probe-diagnostics'

export async function refreshRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs: number,
  publish: (status: RuntimeEnvironmentStatus) => void
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
    publish({ status, checkedAt: Date.now() })
    return true
  } catch (error: unknown) {
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentRevision) {
      return false
    }
    const remoteControl = extractRuntimeTransportDiagnostics(error)
    publish({
      status: null,
      ...(remoteControl ? { remoteControl } : {}),
      checkedAt: Date.now()
    })
    return false
  }
}
