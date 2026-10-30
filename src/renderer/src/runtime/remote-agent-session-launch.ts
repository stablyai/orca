import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

export async function runRemoteAgentSessionLaunch<TResult>(args: {
  environmentId: string
  hostAuthority?: () => Promise<TResult>
  hostAuthorityCapability?: RuntimeCapability
  legacy: (options: { skipCompatibilityCheck: boolean }) => Promise<TResult>
}): Promise<TResult> {
  if (!args.hostAuthority) {
    return await args.legacy({ skipCompatibilityCheck: false })
  }
  let supported: boolean
  try {
    supported = await runtimeEnvironmentSupportsCapability(
      args.environmentId,
      args.hostAuthorityCapability ?? AGENT_SESSION_HOST_AUTHORITY_CAPABILITY
    )
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    // Read-only probe failure launched nothing; legacy fallback is safe from duplication during transient upgrades.
    return await args.legacy({ skipCompatibilityCheck: true })
  }
  // Choose before launching: ambiguous structured outcomes must never retry legacy and duplicate agents.
  if (!supported) {
    return await args.legacy({ skipCompatibilityCheck: true })
  }
  try {
    return await args.hostAuthority()
  } catch (error) {
    if (
      error instanceof RuntimeRpcCallError &&
      (error.code === 'agent_session_legacy_required' || error.code === 'method_not_found')
    ) {
      // Both refusals prove no dispatch: new host rejected old ownership or old host did not recognize the method.
      return await args.legacy({ skipCompatibilityCheck: true })
    }
    throw error
  }
}
