import { Monitor, Server } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getActiveServerModeDescription } from './runtime-environment-host-details'
import { LOCAL_RUNTIME_VALUE, NO_RUNTIME_VALUE } from './runtime-environment-selection'

type RuntimeDefaultHostRowProps = {
  allowLocalRuntime: boolean
  activeValue: string
  environments: PublicKnownRuntimeEnvironment[]
  isBusy: boolean
  onValueChange: (value: string) => void
}

/** "New projects open on": the default host for project creation. */
export function RuntimeDefaultHostRow({
  allowLocalRuntime,
  activeValue,
  environments,
  isBusy,
  onValueChange
}: RuntimeDefaultHostRowProps): React.JSX.Element {
  const savedEnvironments = useAppStore((state) => state.runtimeEnvironments)
  // Why: the default can be a host this list leaves out (a WSL distro); show it so it can be changed.
  const unlistedActive =
    activeValue !== LOCAL_RUNTIME_VALUE &&
    activeValue !== NO_RUNTIME_VALUE &&
    !environments.some((environment) => environment.id === activeValue)
      ? savedEnvironments.find((environment) => environment.id === activeValue)
      : undefined
  const options = unlistedActive ? [...environments, unlistedActive] : environments
  if (options.length === 0 && allowLocalRuntime) {
    // Why a quiet line, not the control: nothing to choose yet, but deep links still land here.
    return (
      <p
        data-settings-section="default-runtime"
        className="scroll-mt-8 text-xs text-muted-foreground"
      >
        {translate(
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
          {translate(
            'auto.components.settings.serverList.defaultHostLabel',
            'New projects open on'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {getActiveServerModeDescription(allowLocalRuntime)}
        </p>
      </div>
      <div className="shrink-0">
        <Select
          value={activeValue}
          onValueChange={(value) => {
            if (value !== activeValue) {
              onValueChange(value)
            }
          }}
          disabled={isBusy}
        >
          <SelectTrigger size="sm" className="w-64" aria-labelledby="runtime-active-server-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowLocalRuntime ? (
              <SelectItem value={LOCAL_RUNTIME_VALUE}>
                <Monitor />
                {translate('auto.components.settings.serverList.thisComputer', 'This computer')}
              </SelectItem>
            ) : options.length === 0 ? (
              <SelectItem value={NO_RUNTIME_VALUE} disabled>
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
                  'No server connected'
                )}
              </SelectItem>
            ) : null}
            {options.map((environment) => (
              <SelectItem key={environment.id} value={environment.id}>
                <Server />
                {environment.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
