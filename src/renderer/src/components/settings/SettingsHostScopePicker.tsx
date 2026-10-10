import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  getSettingsHostScopeEnvironmentId,
  type SettingsHostChoice,
  type SettingsHostScope
} from './settings-host-scope'

const LOCAL_VALUE = 'local'
const ENVIRONMENT_VALUE_PREFIX = 'environment:'

type SettingsHostScopePickerProps = {
  scope: SettingsHostScope
  environments: readonly PublicKnownRuntimeEnvironment[]
  onChoose: (choice: SettingsHostChoice) => void
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
  const scopeEnvironmentId = getSettingsHostScopeEnvironmentId(scope)
  const value = scopeEnvironmentId
    ? `${ENVIRONMENT_VALUE_PREFIX}${scopeEnvironmentId}`
    : LOCAL_VALUE
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-8 py-2 text-xs">
      <span className="font-medium text-foreground">
        {translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
      </span>
      <Select
        value={value}
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
      >
        <SelectTrigger
          size="sm"
          aria-label={translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
          className="min-w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LOCAL_VALUE}>{getLocalExecutionHostLabel()}</SelectItem>
          {environments.map((environment) => (
            <SelectItem key={environment.id} value={`${ENVIRONMENT_VALUE_PREFIX}${environment.id}`}>
              {environment.name}
            </SelectItem>
          ))}
          {scopeEnvironmentId && !scope.available ? (
            // Why: a removed server stays selected and says so; it never turns into another host.
            <SelectItem value={value} disabled>
              {translate(
                'auto.components.settings.SettingsHostScopePicker.unavailable',
                '{{value0}} (unavailable)',
                { value0: scopeEnvironmentId }
              )}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">
        {translate(
          'auto.components.settings.SettingsHostScopePicker.description',
          'Accounts, detected agents and terminal options below are for this host.'
        )}
      </span>
    </div>
  )
}

/** Shown in place of a host-owned pane whose chosen server is no longer saved. */
export function SettingsHostScopeUnavailableNotice(): React.JSX.Element {
  return (
    <p className="text-sm text-muted-foreground">
      {translate(
        'auto.components.settings.SettingsHostScopePicker.unavailableNotice',
        'This server is no longer saved, so nothing can be shown for it. Choose another host at the top of Settings.'
      )}
    </p>
  )
}
