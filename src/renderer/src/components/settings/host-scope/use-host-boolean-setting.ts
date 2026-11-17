import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { errorMessage } from '../../../../../shared/errors/error-message'

/** Host-owned switches every newer host reports, so a missing key means an older host. */
export type HostBooleanSettingKey =
  | 'codexShareHistoryAcrossAccounts'
  | 'deleteChatHistoryWithWorkspace'

/** `unsupported`: an older host that neither reports nor accepts the setting. */
export type HostBooleanSetting =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; enabled: boolean }

type HostSettings = { settings: Partial<GlobalSettings> }

const HOST_SETTINGS_TIMEOUT_MS = 15_000

function readHostSetting(
  settings: Partial<GlobalSettings>,
  key: HostBooleanSettingKey
): HostBooleanSetting {
  // settings.update is strict, so writing the key to a host that does not report it would fail.
  const value = settings[key]
  return typeof value === 'boolean' ? { state: 'ready', enabled: value } : { state: 'unsupported' }
}

/** Reads and writes one switch on the host that owns it: this app's settings, or a server's. */
export function useHostBooleanSetting(args: {
  owner: RuntimeClientTarget
  settingKey: HostBooleanSettingKey
  /** This app's own value, used when the owner is this app. */
  localEnabled: boolean
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  updateFailedMessage: string
}): { setting: HostBooleanSetting; update: (enabled: boolean) => Promise<void> } {
  const { owner, settingKey, localEnabled, updateLocalSettings, updateFailedMessage } = args
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const [remote, setRemote] = useState<{
    environmentId: string
    setting: HostBooleanSetting
  } | null>(null)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    void callRuntimeRpc<HostSettings>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined,
      { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
    ).then(
      (result) => {
        if (current) {
          setRemote({ environmentId, setting: readHostSetting(result.settings, settingKey) })
        }
      },
      (error: unknown) => console.error(`Failed to load the host setting ${settingKey}:`, error)
    )
    return () => {
      current = false
    }
  }, [environmentId, settingKey])

  if (!environmentId) {
    return {
      setting: { state: 'ready', enabled: localEnabled },
      update: async (enabled) => {
        try {
          await updateLocalSettings({ [settingKey]: enabled })
        } catch (error) {
          toast.error(updateFailedMessage, { description: errorMessage(error) })
        }
      }
    }
  }
  return {
    setting: remote?.environmentId === environmentId ? remote.setting : { state: 'loading' },
    update: async (enabled) => {
      try {
        const result = await callRuntimeRpc<HostSettings>(
          { kind: 'environment', environmentId },
          'settings.update',
          { [settingKey]: enabled },
          { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
        )
        setRemote({ environmentId, setting: readHostSetting(result.settings, settingKey) })
      } catch (error) {
        toast.error(updateFailedMessage, { description: errorMessage(error) })
      }
    }
  }
}
