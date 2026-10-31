import { markRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { assertRuntimeStatusCompatible } from '@/runtime/runtime-protocol-compat'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

export async function verifyRuntimeEnvironmentReachable(
  environmentId: string | null
): Promise<void> {
  if (!environmentId) {
    return
  }
  const response = await window.api.runtimeEnvironments.getStatus({
    selector: environmentId,
    timeoutMs: 15_000
  })
  const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
  assertRuntimeStatusCompatible(status)
  // Switch already proved compatibility; avoid the heavier generic RPC re-probe during hydration.
  markRuntimeEnvironmentCompatible(environmentId)
}
