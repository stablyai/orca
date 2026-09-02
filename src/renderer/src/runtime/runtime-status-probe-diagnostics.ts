import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime-shared-control-types'
import { RuntimeRpcCallError } from './runtime-rpc-client'

export function extractRuntimeTransportDiagnostics(
  error: unknown
): RemoteRuntimeSharedConnectionDiagnostics | null {
  if (!(error instanceof RuntimeRpcCallError)) {
    return null
  }
  const remoteControl =
    typeof error.response.error.data === 'object' && error.response.error.data !== null
      ? ((
          error.response.error.data as {
            remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
          }
        ).remoteControl ?? null)
      : null
  return remoteControl
}
