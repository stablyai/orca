import { useTranslate } from '@/i18n/use-translate'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectOption
} from '../form-controls/SettingsSearchableSelect'
import type { SettingsHostScope } from './settings-host-scope'

const LOCAL_VALUE = 'local'
const ENVIRONMENT_VALUE_PREFIX = 'environment:'

type SettingsHostScopePickerProps = {
  scope: SettingsHostScope
  environments: readonly PublicKnownRuntimeEnvironment[]
  onChoose: (choice: RuntimeClientTarget) => void
}

export function shouldShowSettingsHostScopePicker(
  scope: SettingsHostScope,
  environments: readonly PublicKnownRuntimeEnvironment[]
): boolean {
  return environments.length > 0 || scope.target.kind === 'environment'
}

export function SettingsHostScopePicker({
  scope,
  environments,
  onChoose
}: SettingsHostScopePickerProps): React.JSX.Element {
  const t = useTranslate()
  const scopeEnvironmentId = runtimeTargetEnvironmentId(scope.target)
  const value = scopeEnvironmentId
    ? `${ENVIRONMENT_VALUE_PREFIX}${scopeEnvironmentId}`
    : LOCAL_VALUE
  const label = t('auto.components.settings.SettingsHostScopePicker.label', 'Host')
  const selectedEnvironmentAvailable = environments.some(
    (environment) => environment.id === scopeEnvironmentId
  )
  const options: SettingsSearchableSelectOption[] = [
    {
      value: LOCAL_VALUE,
      label: getLocalExecutionHostLabel()
    },
    ...environments
      .filter((environment) => scope.available || environment.id !== scopeEnvironmentId)
      .map((environment) => ({
        value: `${ENVIRONMENT_VALUE_PREFIX}${environment.id}`,
        label: environment.name,
        keywords: [environment.id]
      }))
  ]
  if (scopeEnvironmentId && (!scope.available || !selectedEnvironmentAvailable)) {
    options.push({
      value,
      label: scope.available
        ? t('auto.components.settings.SettingsHostScopePicker.loading', 'Loading hosts…')
        : t(
            'auto.components.settings.SettingsHostScopePicker.unavailable',
            '{{value0}} (unavailable)',
            { value0: scopeEnvironmentId }
          ),
      keywords: [scopeEnvironmentId],
      disabled: true
    })
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-8 py-2 text-xs">
      <span className="font-medium text-foreground">{label}</span>
      <SettingsSearchableSelect
        ariaLabel={label}
        value={value}
        groups={[{ key: 'settings-hosts', options }]}
        searchPlaceholder={t(
          'auto.components.settings.SettingsSearchableSelect.searchHosts',
          'Search hosts…'
        )}
        onValueChange={(next) =>
          onChoose(
            next.startsWith(ENVIRONMENT_VALUE_PREFIX)
              ? {
                  kind: 'environment',
                  environmentId: next.slice(ENVIRONMENT_VALUE_PREFIX.length)
                }
              : { kind: 'local' }
          )
        }
      />
      <span className="text-muted-foreground">
        {t(
          'auto.components.settings.SettingsHostScopePicker.description',
          'Accounts, detected agents and terminal options below are for this host.'
        )}
      </span>
    </div>
  )
}

/** Shown in place of a host-owned pane whose chosen server is no longer saved. */
export function SettingsHostScopeUnavailableNotice(): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-sm text-muted-foreground">
      {t(
        'auto.components.settings.SettingsHostScopePicker.unavailableNotice',
        'This server is no longer saved, so nothing can be shown for it. Choose another host at the top of Settings.'
      )}
    </p>
  )
}
