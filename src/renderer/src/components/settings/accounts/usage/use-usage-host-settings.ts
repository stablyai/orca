import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

/** The usage settings the host's own poller reads beside its saved MiniMax/GLM keys. */
export type UsageHostSettings = Partial<
  Pick<
    GlobalSettings,
    'minimaxEndpoint' | 'minimaxGroupId' | 'minimaxUsageModels' | 'zcodePlanSite'
  >
>

export type UsageHostSettingsModel = {
  /** Null while a remote host's values are unknown (loading or unreachable). */
  settings: UsageHostSettings | null
  update: (updates: UsageHostSettings) => Promise<void>
}

function pickUsageHostSettings(settings: Partial<GlobalSettings>): UsageHostSettings {
  return {
    minimaxEndpoint: settings.minimaxEndpoint,
    minimaxGroupId: settings.minimaxGroupId,
    minimaxUsageModels: settings.minimaxUsageModels,
    zcodePlanSite: settings.zcodePlanSite
  }
}

export function useUsageHostSettings(
  owner: RuntimeClientTarget,
  hostLabel: string | null,
  localSettings: GlobalSettings,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
): UsageHostSettingsModel {
  const t = useTranslate()
  const ownerEnvironmentId = owner.kind === 'environment' ? owner.environmentId : null
  const [remote, setRemote] = useState<{
    environmentId: string
    settings: UsageHostSettings
  } | null>(null)

  useEffect(() => {
    if (!ownerEnvironmentId) {
      return
    }
    let current = true
    void callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
      { kind: 'environment', environmentId: ownerEnvironmentId },
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    ).then(
      (result) => {
        if (current) {
          setRemote({
            environmentId: ownerEnvironmentId,
            settings: pickUsageHostSettings(result.settings)
          })
        }
      },
      (error: unknown) => console.error('Failed to load host usage settings:', error)
    )
    return () => {
      current = false
    }
  }, [ownerEnvironmentId])

  if (!ownerEnvironmentId) {
    return {
      settings: pickUsageHostSettings(localSettings),
      update: async (updates) => {
        await updateLocalSettings(updates)
      }
    }
  }
  return {
    settings: remote?.environmentId === ownerEnvironmentId ? remote.settings : null,
    update: async (updates) => {
      try {
        const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
          { kind: 'environment', environmentId: ownerEnvironmentId },
          'settings.update',
          updates,
          { timeoutMs: 15_000 }
        )
        setRemote({
          environmentId: ownerEnvironmentId,
          settings: pickUsageHostSettings(result.settings)
        })
      } catch (error) {
        toast.error(
          t(
            'auto.components.settings.useUsageHostSettings.updateFailed',
            'Could not update the setting on {{host}}.',
            { host: hostLabel ?? '' }
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}
