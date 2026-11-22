import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { Translate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host/execution-host'
import { errorMessage } from '../../../../../shared/errors/error-message'
import type { HostNotificationSettings } from '../../../../../shared/notifications/notification-settings-types'
import {
  readHostOwnedSetting,
  resolveHostOwnedSetting,
  type HostOwnedSettingKey,
  type HostOwnedSettings
} from '../../../../../shared/settings/host-owned-settings'

/** `unsupported`: an older host that neither reports nor accepts the setting. */
export type HostSetting<V> =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'ready'; value: V }

/** What settings.get/update answer with: this host's client-visible settings. */
export type HostSettingsReply = Partial<GlobalSettings> & {
  hostNotifications?: Partial<HostNotificationSettings>
}

type HostSettings = { settings: HostSettingsReply }

const HOST_SETTINGS_TIMEOUT_MS = 15_000
// Rows of one pane mount together; they share one settings.get per host.
const inFlightReads = new Map<string, Promise<HostSettings>>()

function readHostSettings(environmentId: string): Promise<HostSettings> {
  const pending = inFlightReads.get(environmentId)
  if (pending) {
    return pending
  }
  const read = callRuntimeRpc<HostSettings>(
    { kind: 'environment', environmentId },
    'settings.get',
    undefined,
    { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
  ).finally(() => inFlightReads.delete(environmentId))
  inFlightReads.set(environmentId, read)
  return read
}

/** Reads one value from a server's settings and writes updates back. `read` must be stable and
 *  returns undefined for an older host; settings.update is strict, so such a host would refuse the write. */
export function useServerSettingValue<T>(args: {
  environmentId: string | null
  read: (settings: HostSettingsReply) => T | undefined
  updateFailedMessage: string
}): {
  setting: HostSetting<T>
  /** `shown` displays at once, so a second edit builds on it (list rows derive the next value). */
  update: (updates: Record<string, unknown>, shown?: T) => Promise<void>
} {
  const { environmentId, read, updateFailedMessage } = args
  const [remote, setRemote] = useState<{ environmentId: string; setting: HostSetting<T> } | null>(
    null
  )
  // A slower reply to an earlier write, or one from the previous host, must not undo a later state.
  const generation = useRef(0)
  const settle = useCallback(
    (owner: string, settings: HostSettingsReply): void => {
      const value = read(settings)
      setRemote({
        environmentId: owner,
        setting: value === undefined ? { state: 'unsupported' } : { state: 'ready', value }
      })
    },
    [read]
  )

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    const loaded = ++generation.current
    void readHostSettings(environmentId).then(
      (result) => {
        if (current && loaded === generation.current) {
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
    update: async (updates, shown) => {
      if (!environmentId) {
        return
      }
      const written = ++generation.current
      if (shown !== undefined) {
        setRemote({ environmentId, setting: { state: 'ready', value: shown } })
      }
      try {
        const result = await callRuntimeRpc<HostSettings>(
          { kind: 'environment', environmentId },
          'settings.update',
          updates,
          { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
        )
        if (written === generation.current) {
          settle(environmentId, result.settings)
        }
      } catch (error) {
        // Text rows write per keystroke; one toast per host.
        toast.error(updateFailedMessage, {
          id: `host-setting:${environmentId}`,
          description: errorMessage(error)
        })
        // Put back what the host really has, unless a later edit took over.
        void readHostSettings(environmentId).then(
          (result) => {
            if (written === generation.current) {
              settle(environmentId, result.settings)
            }
          },
          () => {}
        )
      }
    }
  }
}

/** The picked host's name, or this computer's. */
export function useSettingsHostLabel(owner: RuntimeClientTarget): string {
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  return hostName ?? getLocalExecutionHostLabel()
}

/** Reads and writes one setting on the host that owns it: this app's settings, or a server's. */
export function useHostSetting<K extends HostOwnedSettingKey>(args: {
  owner: RuntimeClientTarget
  settingKey: K
  /** This app's own settings, used when the owner is this app. */
  localSettings: Partial<GlobalSettings>
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  updateFailedMessage: string
}): {
  setting: HostSetting<HostOwnedSettings[K]>
  update: (value: HostOwnedSettings[K]) => Promise<void>
} {
  const { owner, settingKey, localSettings, updateLocalSettings, updateFailedMessage } = args
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const read = useCallback(
    (settings: HostSettingsReply) => readHostOwnedSetting(settings, settingKey),
    [settingKey]
  )
  const remote = useServerSettingValue({ environmentId, read, updateFailedMessage })

  if (!environmentId) {
    return {
      setting: { state: 'ready', value: resolveHostOwnedSetting(localSettings, settingKey) },
      update: async (value) => {
        try {
          await updateLocalSettings({ [settingKey]: value })
        } catch (error) {
          toast.error(updateFailedMessage, { description: errorMessage(error) })
        }
      }
    }
  }
  return {
    setting: remote.setting,
    update: (value) => remote.update({ [settingKey]: value }, value)
  }
}

export function getHostSettingUnsupportedNote(host: string, t: Translate): string {
  return t(
    'components.settings.hostScope.updateHostToChange',
    'Update Orca on {{host}} to change this setting there.',
    { host }
  )
}

export function getHostSettingUpdateFailedMessage(host: string, t: Translate): string {
  return t(
    'components.settings.hostScope.updateFailed',
    "Couldn't update the setting on {{host}}.",
    { host }
  )
}
