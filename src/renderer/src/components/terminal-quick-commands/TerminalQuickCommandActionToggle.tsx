import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { TerminalQuickCommandDialogAction } from './terminal-quick-command-dialog-draft'
import { QUICK_COMMAND_TOGGLE_ITEM_CLASS } from './terminal-quick-command-toggle-style'
import { translate } from '@/i18n/i18n'

type TerminalQuickCommandActionToggleProps = {
  selectedAction: TerminalQuickCommandDialogAction
  onActionChange: (action: TerminalQuickCommandDialogAction) => void
}

export function TerminalQuickCommandActionToggle({
  selectedAction,
  onActionChange
}: TerminalQuickCommandActionToggleProps): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={selectedAction}
      onValueChange={(value) => {
        if (value === 'terminal-command' || value === 'agent-prompt') {
          onActionChange(value)
        }
      }}
      // Why: equal columns keep the control width stable when labels differ by locale.
      className="grid w-[11.5rem] grid-cols-2"
      variant="outline"
    >
      <ToggleGroupItem
        value="terminal-command"
        className={cn(QUICK_COMMAND_TOGGLE_ITEM_CLASS, 'w-full justify-center')}
        aria-label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandActionToggle.b5ea4d64f6',
          'Terminal Command'
        )}
      >
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandActionToggle.terminal_short',
          'Terminal'
        )}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="agent-prompt"
        className={cn(QUICK_COMMAND_TOGGLE_ITEM_CLASS, 'w-full justify-center')}
        aria-label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandActionToggle.b0d58e37ed',
          'Agent Prompt'
        )}
      >
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandActionToggle.agent_short',
          'Agent'
        )}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
