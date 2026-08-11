import { translate } from '@/i18n/i18n'
import { Switch } from '@/components/ui/switch'
type TerminalQuickCommandAppendEnterSwitchProps = {
  appendEnter: boolean
  onToggle: () => void
}

export function TerminalQuickCommandAppendEnterSwitch({
  appendEnter,
  onToggle
}: TerminalQuickCommandAppendEnterSwitchProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.5fa607d807',
            'Append Enter'
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.c936c2d6d2',
            'Submit immediately instead of only inserting text.'
          )}
        </div>
      </div>
      <Switch
        checked={appendEnter}
        aria-label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.e4e5fed3b3',
          'Toggle append Enter'
        )}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
