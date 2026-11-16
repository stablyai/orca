import { migrateAgentPermissionChoice } from '../../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import { usableAgentPickerDefaultSettings } from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store'
import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-permission-modes-capability'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation,
  AgentLaunchSettingsSource
} from '../../../../shared/agent-launch/choices/agent-launch-settings'
import {
  AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY,
  AGENT_LAUNCH_SETTINGS_CAPABILITY,
  AGENT_LAUNCH_CHOICES_CAPABILITY
} from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

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

/** Historical projections compose permission/model flags; restore their existing typed meaning. */
export function hostAgentLaunchSettingsSource(
  snapshot: AgentLaunchSettings,
  platform?: NodeJS.Platform
): AgentLaunchSettingsSource {
  const permission = snapshot.agentPermission
  const choices = snapshot.agentChoices
  return {
    defaultTuiAgent: snapshot.defaultTuiAgent,
    disabledTuiAgents: snapshot.disabledTuiAgents,
    agentCmdOverrides: snapshot.agentCmdOverrides,
    ...migrateAgentPermissionChoice(
      {
        agentDefaultArgs: choices?.userArgs ?? permission?.userArgs ?? snapshot.agentDefaultArgs,
        ...(choices ? { agentLaunchChoices: choices.defaults } : {}),
        ...(permission
          ? {
              agentPermissionDefault: permission.default,
              agentPermissionOverrides: permission.overrides
            }
          : {})
      },
      platform
    )
  }
}

export async function readHostAgentStartupSettings(
  owner: AgentLaunchSettingsOwner,
  signal?: AbortSignal
): Promise<AgentLaunchSettingsSource | null> {
  const result = await callRuntimeRpc<{ settings?: AgentLaunchSettingsSource }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.get',
    undefined,
    {
      expectedEnvironmentPairingRevision: owner.pairingRevision,
      ...(owner.runtimeId ? { expectedEnvironmentRuntimeId: owner.runtimeId } : {}),
      signal,
      timeoutMs: 15_000
    }
  )
  if (!usableAgentPickerDefaultSettings(result?.settings)) {
    return null
  }
  const settings = result.settings
  const platform = lastVerifiedRuntimeStatus(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(owner.environmentId)
  )?.hostPlatform
  return { ...settings, ...migrateAgentPermissionChoice(settings, platform) }
}

export async function readHostAgentLaunchDefaults(
  owner: AgentLaunchSettingsOwner,
  signal?: AbortSignal
): Promise<{ settings: AgentLaunchSettingsSource; structuredKnown: boolean } | null> {
  const snapshot = await readHostAgentLaunchSettings(owner, signal).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    return null
  })
  if (usableAgentPickerDefaultSettings(snapshot)) {
    const platform = lastVerifiedRuntimeStatus(
      useAppStore.getState().runtimeStatusByEnvironmentId.get(owner.environmentId)
    )?.hostPlatform
    return { settings: hostAgentLaunchSettingsSource(snapshot, platform), structuredKnown: false }
  }
  const settings = await readHostAgentStartupSettings(owner, signal)
  return settings ? { settings, structuredKnown: true } : null
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
  if (
    (mutation.type === 'permission' || mutation.type === 'user-arguments') &&
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY
    ))
  ) {
    throw new Error('agent_launch_permission_choice_unsupported')
  }
  if (
    mutation.type === 'launch-choices' &&
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      AGENT_LAUNCH_CHOICES_CAPABILITY
    ))
  ) {
    throw new Error('agent_launch_choices_unsupported')
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

export function hostSupportsOwnChatPermissions(owner: AgentLaunchSettingsOwner): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    owner.environmentId,
    AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
  )
}

export function hostSupportsLaunchChoices(owner: AgentLaunchSettingsOwner): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(owner.environmentId, AGENT_LAUNCH_CHOICES_CAPABILITY)
}
