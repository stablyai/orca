import { Laptop, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsSwitch } from './SettingsFormControls'

const NO_DETAILS: readonly string[] = []

export type SessionHistoryComputerRowProps = {
  kind: 'local' | 'server'
  name: string
  /** Paired servers only; a host that never answered has no version to claim. */
  version?: string | null
  /** Empty when this client cannot read the host's index at all, as in the browser. */
  status?: string
  details?: readonly string[]
  /** An offline or too-old computer is still listed, just visibly out of play. */
  dimmed?: boolean
  checked: boolean
  disabled?: boolean
  onToggle: () => void
  action?: { label: string; onClick: () => void } | null
}

export function SessionHistoryComputerRow({
  kind,
  name,
  version,
  status,
  details = NO_DETAILS,
  dimmed = false,
  checked,
  disabled = false,
  onToggle,
  action = null
}: SessionHistoryComputerRowProps): React.JSX.Element {
  const Icon = kind === 'local' ? Laptop : Server
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-border py-3', dimmed && 'opacity-60')}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {version ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {translate('sessionHistory.settings.serverVersion', 'Orca v{{version}}', { version })}
            </span>
          ) : null}
        </div>
        {status ? (
          <p role="status" className="text-xs text-muted-foreground">
            {status}
            {action ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="ml-1 h-auto align-baseline"
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ) : null}
          </p>
        ) : null}
        {details.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      <div className="shrink-0">
        <SettingsSwitch
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          ariaLabel={translate(
            'sessionHistory.settings.rowSwitchLabel',
            'Search sessions on {{host}}',
            {
              host: name
            }
          )}
        />
      </div>
    </div>
  )
}
