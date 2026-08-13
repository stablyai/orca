import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import {
  TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import { TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE } from '../../../shared/legacy-terminal-attribution-env'
import {
  probeLiveRuntimeEnvironmentCapabilities,
  RuntimeRpcCallError,
  type LiveRuntimeEnvironmentAuthority
} from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

export async function runRemoteAgentSessionLaunch<TResult>(args: {
  environmentId: string
  expectedEnvironmentPairingRevision?: number
  hostAuthority?: (authority: LiveRuntimeEnvironmentAuthority) => Promise<TResult>
  requiredHostAuthorityCapabilities?: readonly RuntimeCapability[]
  legacy: (options: {
    skipCompatibilityCheck: boolean
    authority: LiveRuntimeEnvironmentAuthority
  }) => Promise<TResult>
}): Promise<TResult> {
  const requiredCapabilities = [
    TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY,
    ...(args.hostAuthority ? [AGENT_SESSION_HOST_AUTHORITY_CAPABILITY] : []),
    ...(args.requiredHostAuthorityCapabilities ?? [])
  ]
  let probe: Awaited<ReturnType<typeof probeLiveRuntimeEnvironmentCapabilities>>
  try {
    probe = await probeLiveRuntimeEnvironmentCapabilities({
      environmentId: args.environmentId,
      requiredCapabilities,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
    })
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
    // Why: unknown-outcome recovery still needs to classify a transient failed probe.
    throw Object.assign(
      new Error(TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE, { cause: error }),
      typeof code === 'string' ? { code } : {}
    )
  }
  if (!probe.authority.capabilities.includes(TERMINAL_ATTRIBUTION_REMOVED_RUNTIME_CAPABILITY)) {
    throw new Error(TERMINAL_CREATE_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE)
  }
  if (!args.hostAuthority || !probe.supported) {
    return await args.legacy({ skipCompatibilityCheck: true, authority: probe.authority })
  }
  try {
    return await args.hostAuthority(probe.authority)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'agent_session_legacy_required') {
      return await args.legacy({ skipCompatibilityCheck: true, authority: probe.authority })
    }
    throw error
  }
}
