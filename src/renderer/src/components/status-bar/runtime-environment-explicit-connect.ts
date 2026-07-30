import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '../../store'

export async function connectRuntimeEnvironmentAndRecordStatus(
  environmentId: string,
  timeoutMs: number
): Promise<boolean> {
  const setStatus = useAppStore.getState().setRuntimeEnvironmentStatus
  try {
    const response = await window.api.runtimeEnvironments.connect({
      selector: environmentId,
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
    setStatus(environmentId, { status, checkedAt: Date.now() })
    return true
  } catch {
    setStatus(environmentId, { status: null, checkedAt: Date.now() })
    return false
  }
}
