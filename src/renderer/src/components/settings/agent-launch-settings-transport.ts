import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import { AGENT_LAUNCH_SETTINGS_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

export type AgentLaunchSettingsOwner = {
  environmentId: string
  pairingRevision?: number
}

export async function readHostAgentLaunchSettings(
  owner: AgentLaunchSettingsOwner,
  signal?: AbortSignal
): Promise<AgentLaunchSettings | null> {
  if (
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_SETTINGS_CAPABILITY
    ))
  ) {
    return null
  }
  const result = await callRuntimeRpc<{ settings: AgentLaunchSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.getAgentLaunch',
    undefined,
    { expectedEnvironmentPairingRevision: owner.pairingRevision, signal, timeoutMs: 15_000 }
  )
  return result.settings
}

export async function mutateHostAgentLaunchSettings(
  owner: AgentLaunchSettingsOwner,
  mutation: AgentLaunchSettingsMutation,
  signal?: AbortSignal
): Promise<AgentLaunchSettings> {
  if (
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_SETTINGS_CAPABILITY
    ))
  ) {
    throw new Error('agent_launch_settings_unsupported')
  }
  const result = await callRuntimeRpc<{ settings: AgentLaunchSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.mutateAgentLaunch',
    mutation,
    { expectedEnvironmentPairingRevision: owner.pairingRevision, signal, timeoutMs: 15_000 }
  )
  return result.settings
}
