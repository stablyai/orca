// Which of the panel's seven kinds a sidebar host is, and whether it can answer now. Read only from
// what the renderer already knows; nothing here contacts, wakes or starts the host.
import type { ExecutionHostHealth } from '../../../../shared/execution-host/execution-host-health'
import type { ExecutionHostKind } from '../../../../shared/execution-host'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import {
  isEphemeralVmRuntimeEnvironment,
  isWslHostRuntimeEnvironment,
  type OrcadDeploymentLink,
  type RuntimeEnvironmentSource
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { AgentHostAvailability, AgentHostKind } from './agent-host-capabilities'

type AgentHostEnvironmentFacts = {
  name?: string | null
  source?: RuntimeEnvironmentSource
  orcadDeployment?: OrcadDeploymentLink | null
}

export function agentHostKind(
  hostKind: ExecutionHostKind,
  environment: AgentHostEnvironmentFacts | null
): AgentHostKind {
  if (hostKind === 'local') {
    return 'local'
  }
  // A plain SSH target is the relay without an Orca server; one with a server is a runtime host.
  if (hostKind === 'ssh') {
    return 'sshClassic'
  }
  if (!environment) {
    return 'paired'
  }
  if (isOrcaCloudRuntimeEnvironment(environment)) {
    return 'cloud'
  }
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    return 'recipe'
  }
  if (isWslHostRuntimeEnvironment(environment)) {
    return 'wsl'
  }
  return environment.orcadDeployment ? 'sshOrcad' : 'paired'
}

export function agentHostAvailability(
  kind: AgentHostKind,
  facts: {
    health: ExecutionHostHealth
    /** WSL: the distro is stopped (never started to probe). */
    wslStopped?: boolean
    /** Orca Cloud: from the control plane's view of the workspace, never the sandbox. */
    cloud?: { asleep: boolean; archived: boolean } | null
  }
): AgentHostAvailability {
  if (kind === 'local') {
    return 'available'
  }
  if (kind === 'cloud') {
    // Cloud rows come from the Orca account, so an asleep sandbox reads the same (nothing to check).
    return facts.cloud?.archived ? 'archived' : facts.cloud?.asleep ? 'asleep' : 'available'
  }
  if (kind === 'wsl' && facts.wslStopped) {
    return 'stopped'
  }
  switch (facts.health) {
    case 'local':
    case 'available':
      return 'available'
    case 'suspended':
    case 'waking':
    case 'provisioning':
      return kind === 'recipe' ? 'suspended' : 'unreachable'
    case 'connecting':
    case 'disconnected':
      return kind === 'sshClassic' || kind === 'sshOrcad' ? 'disconnected' : 'unreachable'
    case 'blocked':
    case 'error':
      return 'unreachable'
  }
}
