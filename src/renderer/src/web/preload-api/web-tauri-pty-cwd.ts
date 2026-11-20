import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { unwrapRuntimeRpcResult } from '../../runtime/rpc/calls/runtime-rpc-result'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { callEnvironmentEnvelope } from '../runtime/client/web-runtime-calls'
import type { TauriPtyState } from './web-tauri-pty-state'

type TauriPtyCwdBinding = Pick<TauriPtyState, 'handle' | 'cwd' | 'endpoint'>

export async function readTauriPtyCwd(
  id: string,
  stateFor: (id: string) => TauriPtyCwdBinding | null
): Promise<string> {
  const state = stateFor(id)
  const environmentId = parseRemoteRuntimePtyId(id)?.environmentId
  if (!state || !environmentId) {
    return ''
  }
  let cwd: string
  try {
    const result = unwrapRuntimeRpcResult(
      await callEnvironmentEnvelope<{ cwd: string | null }>(environmentId, 'terminal.cwd', {
        terminal: state.handle,
        ...(state.endpoint.incarnationId
          ? { expectedIncarnationId: state.endpoint.incarnationId }
          : {})
      })
    )
    cwd = typeof result.cwd === 'string' && result.cwd.trim().length > 0 ? result.cwd : ''
  } catch (error) {
    if (!hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw error
    }
    // Older hosts can only supply the last known directory, never a workspace id as a path.
    cwd = state.cwd
  }
  if (stateFor(id) !== state) {
    return ''
  }
  if (cwd) {
    state.cwd = cwd
  }
  return cwd
}
