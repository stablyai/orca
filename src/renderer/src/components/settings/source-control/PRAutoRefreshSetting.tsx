import { useEffect } from 'react'
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
import {
  useHostLacksPRAutoRefresh,
  useHostPRAutoRefreshCadence
} from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import {
  readHostPRAutoRefreshCadence,
  rememberHostPRAutoRefreshWrite
} from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence-sync'
import { PRAutoRefreshControl } from './PRAutoRefreshControl'

/** The cadence belongs to the host that runs the GitHub reads, so a remote host is read and
 *  written through its own settings. The control shows the one shared copy of that host's setting
 *  (not a snapshot of its own): a change made from another client, or by the host's own
 *  `settingsChanged`, is reflected while this row is mounted, so what it shows is what choosing
 *  an option is compared against. */
function usePRAutoRefreshHostCadence(
  target: RuntimeClientTarget,
  localSettings: GlobalSettings,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  t: Translate
): {
  cadence: PRAutoRefreshCadence | null
  /** The paired host is an older Orca without the setting: it polls at Default and cannot be set. */
  unsupported: boolean
  update: (cadence: PRAutoRefreshCadence) => Promise<void>
} {
  const environmentId = runtimeTargetEnvironmentId(target)
  const remote = useHostPRAutoRefreshCadence(environmentId)
  const unsupported = useHostLacksPRAutoRefresh(environmentId)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    // Re-read on mount even when known: the host may have changed while this client had no contact.
    // The sync's own fences drop the answer if a write or an unpairing lands first.
    void readHostPRAutoRefreshCadence(environmentId)
  }, [environmentId])

  if (!environmentId) {
    return {
      cadence: normalizePRAutoRefreshCadence(localSettings.prAutoRefresh),
      unsupported: false,
      update: async (cadence) => {
        await updateLocalSettings({ prAutoRefresh: cadence })
      }
    }
  }
  return {
    cadence: remote,
    unsupported,
    update: async (cadence) => {
      try {
        const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
          { kind: 'environment', environmentId },
          'settings.update',
          { prAutoRefresh: cadence },
          { timeoutMs: 15_000 }
        )
        // Remembered for the host it was written to, even if Settings has moved on to another host.
        rememberHostPRAutoRefreshWrite(environmentId, result.settings.prAutoRefresh)
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
  const { cadence, unsupported, update } = usePRAutoRefreshHostCadence(
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
      unsupported={unsupported}
      disabled={!hostScope.available}
    />
  )
}
