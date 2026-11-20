import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { errorMessage } from '../../../../../shared/errors/error-message'
import type { HostNotificationSettings } from '../../../../../shared/notifications/notification-settings-types'

/** Host-owned switches every newer host reports, so a missing key means an older host. */
export type HostBooleanSettingKey =
  | 'codexShareHistoryAcrossAccounts'
  | 'deleteChatHistoryWithWorkspace'
  | 'nativeChatAutoContinueAfterUsageLimit'

/** `unsupported`: an older host that neither reports nor accepts the setting. */
export type HostSettingValue<T> =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; value: T }

export type HostBooleanSetting =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; enabled: boolean }

/** What settings.get/update answer with: this host's client-visible settings. */
export type HostSettingsReply = Partial<GlobalSettings> & {
  hostNotifications?: Partial<HostNotificationSettings>
}

type HostSettings = { settings: HostSettingsReply }

const HOST_SETTINGS_TIMEOUT_MS = 15_000

/** Reads one value from a server's settings and writes updates back. `read` must be stable and
 *  returns undefined for an older host; settings.update is strict, so such a host would refuse the write. */
export function useServerSettingValue<T>(args: {
  environmentId: string | null
  read: (settings: HostSettingsReply) => T | undefined
  updateFailedMessage: string
}): {
  setting: HostSettingValue<T>
  update: (updates: Record<string, unknown>) => Promise<void>
} {
  const { environmentId, read, updateFailedMessage } = args
  const [remote, setRemote] = useState<{
    environmentId: string
    setting: HostSettingValue<T>
  } | null>(null)
  const settle = useCallback(
    (owner: string, settings: HostSettingsReply, fromWrite = false) => {
      const value = read(settings)
      const next = {
        environmentId: owner,
        setting:
          value === undefined
            ? { state: 'unsupported' as const }
            : { state: 'ready' as const, value }
      }
      // A write that resolves after another host loaded must not replace that host's value.
      setRemote((current) =>
        fromWrite && current && current.environmentId !== owner ? current : next
      )
    },
    [read]
  )

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
          settle(environmentId, result.settings)
        }
      },
      (error: unknown) => console.error('Failed to load host settings:', error)
    )
    return () => {
      current = false
    }
  }, [environmentId, settle])

  return {
    setting:
      environmentId && remote?.environmentId === environmentId
        ? remote.setting
        : { state: 'loading' },
    update: async (updates) => {
      if (!environmentId) {
        return
      }
      try {
        const result = await callRuntimeRpc<HostSettings>(
          { kind: 'environment', environmentId },
          'settings.update',
          updates,
          { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
        )
        settle(environmentId, result.settings, true)
      } catch (error) {
        toast.error(updateFailedMessage, { description: errorMessage(error) })
      }
    }
  }
}

/** Host-owned choices every newer host reports, so a missing key means an older host. */
export type HostChoiceSettingKey = 'claudeFlaggedRequestAction'

/** Reads and writes one value on the host that owns it: this app's settings, or a server's. */
export function useHostSettingValue<T>(args: {
  owner: RuntimeClientTarget
  settingKey: HostBooleanSettingKey | HostChoiceSettingKey
  /** Must be stable; undefined marks an older host. */
  read: (settings: HostSettingsReply) => T | undefined
  /** This app's own value, used when the owner is this app. */
  localValue: T
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  updateFailedMessage: string
}): { setting: HostSettingValue<T>; update: (value: T) => Promise<void> } {
  const { owner, settingKey, read, localValue, updateLocalSettings, updateFailedMessage } = args
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const remote = useServerSettingValue({ environmentId, read, updateFailedMessage })

  if (!environmentId) {
    return {
      setting: { state: 'ready', value: localValue },
      update: async (value) => {
        try {
          await updateLocalSettings({ [settingKey]: value })
        } catch (error) {
          toast.error(updateFailedMessage, { description: errorMessage(error) })
        }
      }
    }
  }
  return { setting: remote.setting, update: (value) => remote.update({ [settingKey]: value }) }
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
  const { settingKey, localEnabled, ...rest } = args
  const read = useCallback(
    (settings: HostSettingsReply) => {
      const value = settings[settingKey]
      return typeof value === 'boolean' ? value : undefined
    },
    [settingKey]
  )
  const { setting, update } = useHostSettingValue({
    ...rest,
    settingKey,
    read,
    localValue: localEnabled
  })
  return {
    setting: setting.state === 'ready' ? { state: 'ready', enabled: setting.value } : setting,
    update
  }
}
