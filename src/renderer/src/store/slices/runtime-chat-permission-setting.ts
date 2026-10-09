import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { HostChatPermissionSetting } from '@/runtime/host-chat-permission-setting'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export const runtimeChatPermissionSetting = new HostChatPermissionSetting()

export function runtimeChatPermissionOwner(environmentId: string): string {
  return `${environmentId}:${getRuntimeEnvironmentRevision(environmentId) ?? 'unreported'}`
}

export function settingsForRuntimeChatPermissionOwner(settings: GlobalSettings): GlobalSettings {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? {
        ...settings,
        nativeChatPermissionMode: runtimeChatPermissionSetting.value(
          runtimeChatPermissionOwner(target.environmentId)
        )
      }
    : settings
}

export async function writeRuntimeChatPermissionSetting(
  environmentId: string,
  updates: Partial<GlobalSettings>
): Promise<void> {
  const owner = runtimeChatPermissionOwner(environmentId)
  if (runtimeChatPermissionSetting.value(owner) === undefined) {
    throw new Error('Update this server to configure chat permissions.')
  }
  const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
    { kind: 'environment', environmentId },
    'settings.update',
    { nativeChatPermissionMode: updates.nativeChatPermissionMode },
    { timeoutMs: 15_000 }
  )
  runtimeChatPermissionSetting.captureWrite(owner, result.settings)
}
