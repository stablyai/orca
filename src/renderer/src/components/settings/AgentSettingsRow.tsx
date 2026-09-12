import type { ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsBadge, SettingsSegmentedControl } from './SettingsFormControls'

type AgentAvailability = 'enabled' | 'disabled'

export function AgentRowAction({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentAvailabilityControl({
  label,
  isEnabled,
  onSetEnabled
}: {
  label: string
  isEnabled: boolean
  onSetEnabled: (enabled: boolean) => void
}): React.JSX.Element {
  const value: AgentAvailability = isEnabled ? 'enabled' : 'disabled'
  return (
    <SettingsSegmentedControl<AgentAvailability>
      value={value}
      onChange={(next) => {
        if (next !== value) {
          onSetEnabled(next === 'enabled')
        }
      }}
      ariaLabel={translate(
        'auto.components.settings.AgentsPane.1c9a9679ec',
        '{{value0}} availability',
        { value0: label }
      )}
      size="sm"
      options={[
        {
          value: 'enabled',
          label: translate('auto.components.settings.AgentsPane.d4d2a45d63', 'Enabled')
        },
        {
          value: 'disabled',
          label: translate('auto.components.settings.AgentsPane.8dc0192e48', 'Disabled')
        }
      ]}
    />
  )
}

export function AgentSettingsRow({
  label,
  icon,
  summary,
  isEnabled,
  isDefault,
  onSetEnabled,
  onSetDefault,
  firstAction,
  secondAction,
  detailsOpen = false,
  toggleDetailsLabel,
  onToggleDetails,
  children,
  muted = false
}: {
  label: string
  icon: ReactNode
  summary: ReactNode
  isEnabled: boolean
  isDefault: boolean
  onSetEnabled: (enabled: boolean) => void
  onSetDefault?: () => void
  firstAction?: ReactNode
  secondAction?: ReactNode
  detailsOpen?: boolean
  toggleDetailsLabel?: string
  onToggleDetails?: () => void
  children?: ReactNode
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('py-3', muted && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          {icon}
        </div>
        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {!isEnabled ? (
              <SettingsBadge tone="muted">
                {translate('auto.components.settings.AgentsPane.8dc0192e48', 'Disabled')}
              </SettingsBadge>
            ) : null}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{summary}</div>
        </div>

        <div className="ml-auto grid shrink-0 grid-cols-[max-content_6.5rem_1.75rem_1.75rem_1.75rem] items-center gap-1.5">
          <AgentAvailabilityControl
            label={label}
            isEnabled={isEnabled}
            onSetEnabled={onSetEnabled}
          />
          <div className="flex justify-start">
            {onSetDefault && isEnabled ? (
              <Button
                type="button"
                variant={isDefault ? 'secondary' : 'ghost'}
                size="xs"
                onClick={onSetDefault}
                title={
                  isDefault
                    ? translate('auto.components.settings.AgentsPane.d7625cf8b2', 'Default agent')
                    : translate('auto.components.settings.AgentsPane.5f986a9b92', 'Set as default')
                }
                className="h-7 w-full justify-center gap-1 text-xs"
              >
                {isDefault ? <Check className="size-3" /> : null}
                {isDefault
                  ? translate('auto.components.settings.AgentsPane.24e032fa34', 'Default')
                  : translate('auto.components.settings.AgentsPane.959b67385b', 'Set default')}
              </Button>
            ) : null}
          </div>
          <div className="flex size-7 items-center justify-center">{firstAction}</div>
          <div className="flex size-7 items-center justify-center">{secondAction}</div>
          <div className="flex size-7 items-center justify-center">
            {onToggleDetails ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onToggleDetails}
                aria-label={
                  toggleDetailsLabel ??
                  (detailsOpen
                    ? translate(
                        'auto.components.settings.AgentsPane.cea7d97be1',
                        'Collapse command override'
                      )
                    : translate(
                        'auto.components.settings.AgentsPane.dc4a2ffdc0',
                        'Expand command override'
                      ))
                }
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', detailsOpen && 'rotate-180')}
                />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {detailsOpen ? <div className="mt-3 pl-10">{children}</div> : null}
    </div>
  )
}
