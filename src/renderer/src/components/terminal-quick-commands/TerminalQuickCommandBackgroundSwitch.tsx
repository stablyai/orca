import { translate } from '@/i18n/i18n'
import { Switch } from '@/components/ui/switch'

type TerminalQuickCommandBackgroundSwitchProps = {
  openInBackground: boolean
  onToggle: () => void
  disabled?: boolean
}

export function TerminalQuickCommandBackgroundSwitch({
  openInBackground,
  onToggle,
  disabled = false
}: TerminalQuickCommandBackgroundSwitchProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.cf0b237949',
            'Open in background'
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.6f8f01b606',
            'Run in a new terminal without switching to it.'
          )}
        </div>
      </div>
      <Switch
        checked={openInBackground}
        disabled={disabled}
        aria-label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.bbcfd77bb5',
          'Toggle open in background'
        )}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
