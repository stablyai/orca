import { Monitor, Server } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { SettingsSearchableSelect } from '../../form-controls/SettingsSearchableSelect'
import { getActiveServerModeDescription } from './runtime-environment-host-details'
import { LOCAL_RUNTIME_VALUE, NO_RUNTIME_VALUE } from './runtime-environment-selection'

type RuntimeDefaultHostRowProps = {
  allowLocalRuntime: boolean
  activeValue: string
  environments: PublicKnownRuntimeEnvironment[]
  isBusy: boolean
  onValueChange: (value: string) => void
}

export function RuntimeDefaultHostRow({
  allowLocalRuntime,
  activeValue,
  environments,
  isBusy,
  onValueChange
}: RuntimeDefaultHostRowProps): React.JSX.Element {
  const t = useTranslate()
  const savedEnvironments = useAppStore((state) => state.runtimeEnvironments)
  // Retain unlisted active defaults such as WSL distros so users can change them.
  const unlistedActive =
    activeValue !== LOCAL_RUNTIME_VALUE &&
    activeValue !== NO_RUNTIME_VALUE &&
    !environments.some((environment) => environment.id === activeValue)
      ? savedEnvironments.find((environment) => environment.id === activeValue)
      : undefined
  const options = unlistedActive ? [...environments, unlistedActive] : environments
  const label = t('auto.components.settings.serverList.defaultHostLabel', 'New projects open on')
  if (options.length === 0 && allowLocalRuntime) {
    // No choices need only a quiet line, but retain the deep-link target.
    return (
      <p
        data-settings-section="default-runtime"
        className="scroll-mt-8 text-xs text-muted-foreground"
      >
        {t(
          'auto.components.settings.serverList.defaultHostEmptyLine',
          'New projects open on this computer until you add a server.'
        )}
      </p>
    )
  }
  return (
    <div
      data-settings-section="default-runtime"
      className="flex scroll-mt-8 flex-wrap items-center justify-between gap-3"
    >
      <div className="min-w-0 space-y-0.5">
        <div id="runtime-active-server-label" className="text-sm font-medium">
          {label}
        </div>
        <p className="text-xs text-muted-foreground">
          {getActiveServerModeDescription(allowLocalRuntime, t)}
        </p>
      </div>
      <div className="shrink-0">
        <SettingsSearchableSelect
          ariaLabel={label}
          value={activeValue}
          groups={[
            {
              key: 'runtime-hosts',
              options: [
                ...(allowLocalRuntime
                  ? [
                      {
                        value: LOCAL_RUNTIME_VALUE,
                        label: t(
                          'auto.components.settings.serverList.thisComputer',
                          'This computer'
                        ),
                        icon: <Monitor className="size-4" />
                      }
                    ]
                  : []),
                ...(activeValue === NO_RUNTIME_VALUE
                  ? [
                      {
                        value: NO_RUNTIME_VALUE,
                        label: t(
                          'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
                          'No server connected'
                        ),
                        disabled: true
                      }
                    ]
                  : []),
                ...options.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                  icon: <Server className="size-4" />,
                  keywords: [environment.id]
                })),
                ...(!options.some((environment) => environment.id === activeValue) &&
                activeValue !== LOCAL_RUNTIME_VALUE &&
                activeValue !== NO_RUNTIME_VALUE
                  ? [
                      {
                        value: activeValue,
                        label: t(
                          'auto.components.settings.SettingsHostScopePicker.unavailable',
                          '{{value0}} (unavailable)',
                          { value0: activeValue }
                        ),
                        disabled: true
                      }
                    ]
                  : [])
              ]
            }
          ]}
          onValueChange={(value) => {
            if (value !== activeValue) {
              onValueChange(value)
            }
          }}
          searchPlaceholder={t(
            'auto.components.settings.SettingsSearchableSelect.searchHosts',
            'Search hosts…'
          )}
          disabled={isBusy}
        />
      </div>
    </div>
  )
}
