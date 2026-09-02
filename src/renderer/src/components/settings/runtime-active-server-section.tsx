import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  getActiveServerModeDescription,
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  type RuntimeHostDetails
} from './runtime-environment-host-details'

type RuntimeActiveServerSectionProps = {
  visible: boolean
  advancedOpen: boolean
  allowLocalRuntime: boolean
  localRuntimeValue: string
  noRuntimeValue: string
  activeValue: string
  environments: PublicKnownRuntimeEnvironment[]
  detailsByEnvironmentId: Record<string, RuntimeHostDetails>
  isBusy: boolean
  isLoading: boolean
  onToggleAdvanced: () => void
  onValueChange: (value: string) => void
  onRefresh: () => void
}

export function RuntimeActiveServerSection({
  visible,
  advancedOpen,
  allowLocalRuntime,
  localRuntimeValue,
  noRuntimeValue,
  activeValue,
  environments,
  detailsByEnvironmentId,
  isBusy,
  isLoading,
  onToggleAdvanced,
  onValueChange,
  onRefresh
}: RuntimeActiveServerSectionProps): React.JSX.Element {
  return (
    <div data-settings-section="default-runtime" className={!visible ? 'hidden' : undefined}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggleAdvanced}
        className="-ml-2 text-xs"
        aria-expanded={advancedOpen}
        aria-controls="runtime-server-advanced-content"
      >
        {translate('auto.components.settings.RuntimeEnvironmentsPane.advanced', 'Advanced')}
        <ChevronDown className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')} />
      </Button>

      <div
        id="runtime-server-advanced-content"
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!advancedOpen}
        inert={!advancedOpen}
      >
        <div className="min-h-0">
          <div
            className={cn(
              'space-y-2 px-1 pt-3 pb-1 transition-[opacity,transform] duration-150 ease-out',
              advancedOpen
                ? 'translate-y-0 opacity-100 delay-200'
                : '-translate-y-1 opacity-0 delay-0'
            )}
          >
            <div className="space-y-1">
              <Label id="runtime-active-server-label">
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.64b6bea541',
                  'Active Server'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {getActiveServerModeDescription(allowLocalRuntime)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={activeValue}
                onValueChange={(value) => {
                  if (value !== activeValue) {
                    onValueChange(value)
                  }
                }}
                disabled={isBusy}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-[260px]"
                  aria-labelledby="runtime-active-server-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allowLocalRuntime ? (
                    <SelectItem value={localRuntimeValue}>
                      {translate(
                        'auto.components.settings.RuntimeEnvironmentsPane.78692becbd',
                        'Local desktop'
                      )}
                    </SelectItem>
                  ) : environments.length === 0 ? (
                    <SelectItem value={noRuntimeValue} disabled>
                      {translate(
                        'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
                        'No server connected'
                      )}
                    </SelectItem>
                  ) : null}
                  {environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
                  'Refresh servers'
                )}
                title={translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
                  'Refresh servers'
                )}
                onClick={onRefresh}
                disabled={isLoading || isBusy}
              >
                {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
            {environments.length > 0 ? (
              <div className="space-y-2 pt-2">
                <div className="text-xs font-medium">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.serverDetails',
                    'Server details'
                  )}
                </div>
                <div className="space-y-1 rounded-lg border border-border/50 bg-card/30 p-2">
                  {environments.map((environment) => {
                    const details = detailsByEnvironmentId[environment.id]
                    return (
                      <div
                        key={environment.id}
                        className="grid gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]"
                      >
                        <div className="truncate font-medium text-foreground">
                          {environment.name}
                        </div>
                        <div className="min-w-0 space-y-0.5">
                          <div className="truncate font-mono">
                            {environment.endpoints[0]?.endpoint ??
                              translate(
                                'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                                'No endpoint'
                              )}
                          </div>
                          {details?.runtimeStatus ? (
                            <div className="truncate">
                              {translate(
                                'auto.components.settings.RuntimeEnvironmentsPane.0ef838094a',
                                'Protocol {{value0}}',
                                {
                                  value0:
                                    details.runtimeStatus?.runtimeProtocolVersion ??
                                    details.runtimeStatus?.protocolVersion ??
                                    0
                                }
                              )}
                              {details.runtimeStatus.hostPlatform
                                ? ` · ${details.runtimeStatus.hostPlatform}`
                                : ''}
                              {' · '}
                              {getRuntimeCapabilitiesSummary(details.runtimeStatus)}
                            </div>
                          ) : null}
                          {getHostModelCapabilitySummary(details?.runtimeStatus) ? (
                            <div className="truncate">
                              {getHostModelCapabilitySummary(details?.runtimeStatus)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
