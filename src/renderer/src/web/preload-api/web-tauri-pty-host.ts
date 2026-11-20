import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { unwrapRuntimeRpcResult } from '../../runtime/rpc/calls/runtime-rpc-result'
import { callEnvironmentEnvelope } from '../runtime/client/web-runtime-calls'

export async function callTauriPtyHost<TResult>(
  id: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const environmentId = parseRemoteRuntimePtyId(id)?.environmentId
  if (!environmentId) {
    throw new Error('terminal_owner_unavailable')
  }
  return unwrapRuntimeRpcResult(
    await callEnvironmentEnvelope<TResult>(environmentId, method, params)
  )
}
