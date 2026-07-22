import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import { RuntimeRpcCallError, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

export async function runRemoteAgentSessionLaunch<TResult>(args: {
  environmentId: string
  hostAuthority?: () => Promise<TResult>
  legacy: (options: { skipCompatibilityCheck: boolean }) => Promise<TResult>
}): Promise<TResult> {
  if (!args.hostAuthority) {
    return await args.legacy({ skipCompatibilityCheck: false })
  }
  let supported: boolean
  try {
    supported = await runtimeEnvironmentSupportsCapability(
      args.environmentId,
      AGENT_SESSION_HOST_AUTHORITY_CAPABILITY
    )
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    // Why: a failed read-only probe has not launched anything, so preserving
    // the legacy path cannot duplicate an agent and keeps transient upgrades neutral.
    return await args.legacy({ skipCompatibilityCheck: true })
  }
  // Why: choose before invoking either path; an ambiguous structured outcome
  // must never trigger a legacy retry that could spawn a duplicate.
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
      // Why: both responses prove no structured side effect began: the new host rejected an old
      // lower owner before dispatch, or an old host never recognized the method.
      return await args.legacy({ skipCompatibilityCheck: true })
    }
    throw error
  }
}
