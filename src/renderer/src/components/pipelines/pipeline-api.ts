import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export async function callPipelineRpc<T>(
  method: string,
  params?: unknown
): Promise<T & { runtimeId: string }> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preload owns the RPC envelope; callers select the method's result contract and validate its payload.
  const response = (await window.api.runtime.call({ method, params })) as RuntimeRpcResponse<T>
  const result = unwrapRuntimeRpcResult<T>(response)
  if (!response._meta?.runtimeId) {
    throw new Error('pipeline_runtime_identity_missing')
  }
  return { ...result, runtimeId: response._meta.runtimeId }
}
