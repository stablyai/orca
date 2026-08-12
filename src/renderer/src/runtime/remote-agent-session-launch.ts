import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RuntimeRpcCallError, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

export async function runRemoteAgentSessionLaunch<TResult>(args: {
  environmentId: string
  hostAuthority?: () => Promise<TResult>
  hostAuthorityCapability?: RuntimeCapability
  hostAuthorityCapabilities?: readonly RuntimeCapability[]
  legacy: (options: { skipCompatibilityCheck: boolean }) => Promise<TResult>
}): Promise<TResult> {
  if (!args.hostAuthority) {
    return await args.legacy({ skipCompatibilityCheck: false })
  }
  const capabilities = args.hostAuthorityCapabilities ?? [
    args.hostAuthorityCapability ?? AGENT_SESSION_HOST_AUTHORITY_CAPABILITY
  ]
  const supported = (
    await Promise.all(
      capabilities.map((capability) =>
        runtimeEnvironmentSupportsCapability(args.environmentId, capability)
      )
    )
  ).every(Boolean)
  // Why: choose before invoking either path; an ambiguous structured outcome
  // must never trigger a legacy retry that could spawn a duplicate.
  if (!supported) {
    return await args.legacy({ skipCompatibilityCheck: true })
  }
  try {
    return await args.hostAuthority()
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'agent_session_legacy_required') {
      // Why: only the execution host can prove the lower owner is legacy before dispatch.
      return await args.legacy({ skipCompatibilityCheck: true })
    }
    throw error
  }
}
