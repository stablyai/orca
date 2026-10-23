import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import {
  AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_SETTINGS_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

export type AgentLaunchSettingsOwner = {
  environmentId: string
  pairingRevision?: number
  runtimeId?: string
}

type SettingsListener = (owner: AgentLaunchSettingsOwner) => void
const settingsListeners = new Set<SettingsListener>()

export function subscribeHostAgentLaunchSettings(listener: SettingsListener): () => void {
  settingsListeners.add(listener)
  return () => {
    settingsListeners.delete(listener)
  }
}

export async function readHostAgentLaunchSettings(
  owner: AgentLaunchSettingsOwner,
  signal?: AbortSignal
): Promise<AgentLaunchSettings | null> {
  if (
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_SETTINGS_CAPABILITY,
      15_000
    ))
  ) {
    return null
  }
  const result = await callRuntimeRpc<{ settings: AgentLaunchSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.getAgentLaunch',
    undefined,
    {
      expectedEnvironmentPairingRevision: owner.pairingRevision,
      ...(owner.runtimeId ? { expectedEnvironmentRuntimeId: owner.runtimeId } : {}),
      signal,
      timeoutMs: 15_000
    }
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
  if (
    mutation.type === 'permissions' &&
    (mutation.mode === 'auto' || mutation.agent !== undefined || mutation.exceptAuto) &&
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY
    ))
  ) {
    throw new Error('agent_launch_auto_permissions_unsupported')
  }
  if (
    mutation.type === 'permissions' &&
    mutation.syncNativeChat &&
    !(await hostSupportsNativeChatPermissions(owner))
  ) {
    throw new Error('agent_launch_native_chat_permissions_unsupported')
  }
  const result = await callRuntimeRpc<{ settings: AgentLaunchSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.mutateAgentLaunch',
    mutation,
    { expectedEnvironmentPairingRevision: owner.pairingRevision, signal, timeoutMs: 15_000 }
  )
  if (!signal?.aborted) {
    settingsListeners.forEach((listener) => listener(owner))
  }
  return result.settings
}

export function hostSupportsAutoPermissions(owner: AgentLaunchSettingsOwner): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    owner.environmentId,
    AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY
  )
}

export function hostSupportsNativeChatPermissions(
  owner: AgentLaunchSettingsOwner
): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    owner.environmentId,
    AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY
  )
}
