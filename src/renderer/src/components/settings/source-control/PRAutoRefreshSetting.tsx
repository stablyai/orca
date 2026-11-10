import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  normalizePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import {
  getPRAutoRefreshDescription,
  getPRAutoRefreshTitle,
  PR_AUTO_REFRESH_KEYWORDS
} from './pr-auto-refresh-search'

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
  const environmentId = target.kind === 'environment' ? target.environmentId : null
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
  target,
  settings,
  updateSettings
}: {
  target: RuntimeClientTarget
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const title = getPRAutoRefreshTitle(t)
  const description = getPRAutoRefreshDescription(t)
  const { cadence, update } = usePRAutoRefreshHostCadence(target, settings, updateSettings, t)

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={PR_AUTO_REFRESH_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<PRAutoRefreshCadence>
            value={cadence ?? 'default'}
            onChange={(next) => {
              if (cadence !== null && next !== cadence) {
                void update(next)
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'default',
                label: t('auto.components.settings.GitPane.prAutoRefreshDefault', 'Default'),
                // Unknown until the remote host answers.
                disabled: cadence === null
              },
              {
                value: 'reduced',
                label: t('auto.components.settings.GitPane.prAutoRefreshReduced', 'Reduced'),
                // Unknown until the remote host answers.
                disabled: cadence === null
              },
              {
                value: 'minimal',
                label: t('auto.components.settings.GitPane.prAutoRefreshMinimal', 'Minimal'),
                // Unknown until the remote host answers.
                disabled: cadence === null
              },
              {
                value: 'off',
                label: t('auto.components.settings.GitPane.prAutoRefreshOff', 'Off'),
                // Unknown until the remote host answers.
                disabled: cadence === null
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
