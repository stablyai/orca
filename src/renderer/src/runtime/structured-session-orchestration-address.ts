import {
  formatOrchestrationActor,
  sessionOrchestrationActor
} from '../../../shared/orchestration-actor'
import type { OrchestrationSessionAddressResult } from '../../../shared/orchestration-caller-status'
import { callRuntimeRpc, RuntimeRpcCallError, type RuntimeClientTarget } from './runtime-rpc-client'

/**
 * The address other agents reach a chat at: its conversation's, which the host derives from the
 * session records and which `/clear` keeps. Null for an id that is not an Orca session id.
 */
export async function resolveStructuredSessionOrchestrationAddress(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<string | null> {
  const actor = sessionOrchestrationActor(sessionId)
  if (!actor) {
    return null
  }
  try {
    const result = await callRuntimeRpc<OrchestrationSessionAddressResult>(
      target,
      'orchestration.sessionAddress',
      { sessionId }
    )
    return result.address
  } catch (error) {
    // Why: a host that predates the method has no /clear lineage, so there the live id is the address.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return formatOrchestrationActor(actor)
    }
    throw error
  }
}
