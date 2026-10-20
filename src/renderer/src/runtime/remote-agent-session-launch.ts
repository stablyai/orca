import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import { AGENT_LAUNCH_OMP_THINKING_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import type { TuiAgent } from '../../../shared/tui-agent'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

export async function assertRemoteAgentThinkingSupported(args: {
  environmentId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
}): Promise<void> {
  if (
    args.agent === 'omp' &&
    args.launchPreferences?.effort !== undefined &&
    !(await runtimeEnvironmentSupportsCapability(
      args.environmentId,
      AGENT_LAUNCH_OMP_THINKING_RUNTIME_CAPABILITY
    ))
  ) {
    throw new Error(
      'This Orca host cannot preserve OMP launch thinking. Update Orca on the execution host, or omit the thinking preference.'
    )
  }
}

export async function runRemoteAgentSessionLaunch<TResult>(args: {
  environmentId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  hostAuthority?: () => Promise<TResult>
  hostAuthorityCapability?: RuntimeCapability
  legacy: (options: { skipCompatibilityCheck: boolean }) => Promise<TResult>
}): Promise<TResult> {
  await assertRemoteAgentThinkingSupported(args)
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
