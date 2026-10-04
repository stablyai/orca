import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import type { OrchestrationSessionAddressResult } from '../../../shared/orchestration-caller-status'
import { callRuntimeRpc, RuntimeRpcCallError, type RuntimeClientTarget } from './runtime-rpc-client'

/**
 * A chat's Orca session ID: its `/clear` root's, which the host derives from the session records.
 * Null for an id that is not an Orca session id.
 */
export async function resolveStructuredSessionOrcaSessionId(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<string | null> {
  if (!isOrcaSessionId(sessionId)) {
    return null
  }
  try {
    const result = await callRuntimeRpc<OrchestrationSessionAddressResult>(
      target,
      'orchestration.sessionAddress',
      { sessionId }
    )
    return result.orcaSessionId
  } catch (error) {
    // Why: a host that predates the method routes the current session's ID to the same chat.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return formatOrcaSessionAddress(sessionId)
    }
    throw error
  }
}
