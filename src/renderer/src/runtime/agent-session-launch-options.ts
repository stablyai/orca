import { AGENT_SESSION_CREATE_ENV_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { resolveSshHostProxyEnvForTarget } from '../lib/ssh-host-proxy-env'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

type AgentSessionLaunchOptions = {
  terminalKittyKeyboardProtocol?: true
  env?: Record<string, string>
}

type HostEnvOptions = { env?: Record<string, string> }

/**
 * The per-host `env` an agent-session create on this environment may carry. The create params are a
 * strict object, so the host has to advertise the field before the client sends it; a host that does
 * not simply spawns the agent with its own defaults. The SSH target comes from the caller, since a
 * transport must not read the app store.
 */
function createAgentSessionHostEnvOptions(sshHostTargetId: string | null | undefined) {
  const negotiatedByEnvironment = new Map<string, Promise<HostEnvOptions>>()
  return (environmentId: string): Promise<HostEnvOptions> => {
    const cached = negotiatedByEnvironment.get(environmentId)
    if (cached) {
      // A replay must keep its original payload even after a host upgrade or a settings edit.
      return cached
    }
    const negotiated = (async (): Promise<HostEnvOptions> => {
      try {
        // Why: resolve first. A host with no proxy this client could send skips the capability probe
        // entirely, so every other create keeps the status cache — and the payload — it had before.
        const hostProxyEnv = sshHostTargetId
          ? await resolveSshHostProxyEnvForTarget({
              targetId: sshHostTargetId,
              listTargets: () => window.api.ssh.listTargets()
            })
          : {}
        if (Object.keys(hostProxyEnv).length === 0) {
          return {}
        }
        const supported = await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_CREATE_ENV_RUNTIME_CAPABILITY
        )
        return supported ? { env: hostProxyEnv } : {}
      } catch {
        // Why: the env is an addition, never a gate. A probe that cannot answer (offline host, compat
        // block) must not turn a launch the rest of the path would still attempt into a failure; a
        // host that really cannot serve the call answers the create itself.
        return {}
      }
    })()
    negotiatedByEnvironment.set(environmentId, negotiated)
    return negotiated
  }
}

/**
 * The per-environment fields an agent-session create may carry: the keyboard advertisement, and the
 * host's own proxy env. Each is capability-gated and negotiated once per create, so every call this
 * factory feeds — including a retry of the same create — sends the identical payload.
 */
export function createAgentSessionLaunchOptions(
  kittyKeyboardProtocol: boolean | undefined,
  sshHostTargetId: string | null | undefined
) {
  const keyboardOptions = createAgentSessionKeyboardOptions(kittyKeyboardProtocol)
  const hostEnvOptions = createAgentSessionHostEnvOptions(sshHostTargetId)
  return async (environmentId: string): Promise<AgentSessionLaunchOptions> => ({
    ...(await keyboardOptions(environmentId)),
    ...(await hostEnvOptions(environmentId))
  })
}
