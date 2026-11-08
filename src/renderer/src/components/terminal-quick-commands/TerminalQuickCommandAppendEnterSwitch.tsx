import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { Switch } from '@/components/ui/switch'

type TerminalQuickCommandAppendEnterSwitchProps = {
  appendEnter: boolean
  onToggle: () => void
  compact?: boolean
}

function TerminalQuickCommandFooterSwitch({
  checked,
  ariaLabel,
  label,
  onToggle
}: {
  checked: boolean
  ariaLabel: string
  label: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2">
      <Switch checked={checked} aria-label={ariaLabel} onCheckedChange={onToggle} />
      <span className="truncate text-[11px] text-muted-foreground">{label}</span>
    </label>
  )
}

export function TerminalQuickCommandCloseTabOnSuccessSwitch({
  closeTabOnSuccess,
  onToggle
}: {
  closeTabOnSuccess: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <TerminalQuickCommandFooterSwitch
      checked={closeTabOnSuccess}
      ariaLabel={t(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.close_tab_on_success_aria',
        'Toggle close tab after success'
      )}
      label={t(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.close_tab_on_success',
        'Close tab after success'
      )}
      onToggle={onToggle}
    />
  )
}

export function TerminalQuickCommandAppendEnterSwitch({
  appendEnter,
  onToggle,
  compact = false
}: TerminalQuickCommandAppendEnterSwitchProps): React.JSX.Element {
  if (compact) {
    return (
      <TerminalQuickCommandFooterSwitch
        checked={appendEnter}
        ariaLabel={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.e4e5fed3b3',
          'Toggle append Enter'
        )}
        label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.767e4be3e3',
          'Append Enter — run immediately'
        )}
        onToggle={onToggle}
      />
    )
  }

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
