import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TerminalQuickCommandDialogAction } from './terminal-quick-command-dialog-draft'
import { QUICK_COMMAND_TOGGLE_ITEM_CLASS } from './terminal-quick-command-toggle-style'

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
      className="justify-start"
      variant="outline"
    >
      <ToggleGroupItem value="terminal-command" className={QUICK_COMMAND_TOGGLE_ITEM_CLASS}>
        Terminal Command
      </ToggleGroupItem>
      <ToggleGroupItem value="agent-prompt" className={QUICK_COMMAND_TOGGLE_ITEM_CLASS}>
        Agent Prompt
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
