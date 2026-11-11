import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  normalizePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { rememberHostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import { PRAutoRefreshControl } from './PRAutoRefreshControl'

type HostCadence = { environmentId: string; cadence: PRAutoRefreshCadence }

/** The cadence belongs to the host that runs the GitHub reads, so a remote host is read and
 *  written through its own settings. */
function usePRAutoRefreshHostCadence(
  target: RuntimeClientTarget,
  localSettings: GlobalSettings,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  t: Translate
): {
  cadence: PRAutoRefreshCadence | null
  update: (cadence: PRAutoRefreshCadence) => Promise<void>
} {
  const environmentId = runtimeTargetEnvironmentId(target)
  const [remote, setRemote] = useState<HostCadence | null>(null)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    void callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined,
      { timeoutMs: 15_000 }
    ).then(
      (result) => {
        // The host's schedulers in this window follow the host's own setting, not this app's.
        rememberHostPRAutoRefreshCadence(environmentId, result.settings.prAutoRefresh)
        if (current) {
          setRemote({
            environmentId,
            cadence: normalizePRAutoRefreshCadence(result.settings.prAutoRefresh)
          })
        }
      },
      (error: unknown) => console.error('Failed to load host PR auto-refresh setting:', error)
    )
    return () => {
      current = false
    }
  }, [environmentId])

  if (!environmentId) {
    return {
      cadence: normalizePRAutoRefreshCadence(localSettings.prAutoRefresh),
      update: async (cadence) => {
        await updateLocalSettings({ prAutoRefresh: cadence })
      }
    }
  }
  return {
    cadence: remote?.environmentId === environmentId ? remote.cadence : null,
    update: async (cadence) => {
      try {
        const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
          { kind: 'environment', environmentId },
          'settings.update',
          { prAutoRefresh: cadence },
          { timeoutMs: 15_000 }
        )
        rememberHostPRAutoRefreshCadence(environmentId, result.settings.prAutoRefresh)
        setRemote({
          environmentId,
          cadence: normalizePRAutoRefreshCadence(result.settings.prAutoRefresh)
        })
      } catch (error) {
        toast.error(
          t(
            'auto.components.settings.GitPane.prAutoRefreshUpdateFailed',
            'Could not update PR auto-refresh on this host.'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}

export function PRAutoRefreshSetting({
  hostScope,
  settings,
  updateSettings
}: {
  /** The host chosen at the top of Settings; its timers (and its clients') are what change. */
  hostScope: SettingsHostScope
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const remoteHostName = useAppStateValue((state) =>
    environmentId
      ? (state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name ??
        t('auto.components.settings.GitPane.prAutoRefreshUnknownHost', 'the selected server'))
      : null
  )
  const { cadence, update } = usePRAutoRefreshHostCadence(
    hostScope.target,
    settings,
    updateSettings,
    t
  )
  return (
    <PRAutoRefreshControl
      cadence={cadence}
      onChange={(next) => void update(next)}
      remoteHostName={remoteHostName}
      disabled={!hostScope.available}
    />
  )
}
