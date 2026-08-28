import { translate } from '@/i18n/i18n'
import { Switch } from '@/components/ui/switch'

type TerminalQuickCommandSubmissionSwitchProps = {
  action: 'terminal-command' | 'agent-prompt'
  checked: boolean
  onToggle: () => void
}

export function TerminalQuickCommandSubmissionSwitch({
  action,
  checked,
  onToggle
}: TerminalQuickCommandSubmissionSwitchProps): React.JSX.Element {
  const isAgentPrompt = action === 'agent-prompt'
  const ariaLabel = isAgentPrompt
    ? translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandSubmissionSwitch.toggle_prompt',
        'Toggle immediate prompt submission'
      )
    : translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.e4e5fed3b3',
        'Toggle append Enter'
      )

  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2">
      <Switch checked={checked} aria-label={ariaLabel} onCheckedChange={onToggle} />
      <span className="truncate text-[11px] text-muted-foreground">
        {isAgentPrompt
          ? translate(
              'auto.components.terminal.quick.commands.TerminalQuickCommandSubmissionSwitch.prompt_compact',
              'Submit prompt — run immediately'
            )
          : translate(
              'auto.components.terminal.quick.commands.TerminalQuickCommandAppendEnterSwitch.767e4be3e3',
              'Append Enter — run immediately'
            )}
      </span>
    </label>
  )
}
