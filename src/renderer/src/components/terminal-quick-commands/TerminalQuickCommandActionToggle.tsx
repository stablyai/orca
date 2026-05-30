import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TerminalQuickCommandDialogAction } from './terminal-quick-command-dialog-draft'

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
    >
      <ToggleGroupItem value="terminal-command">Terminal Command</ToggleGroupItem>
      <ToggleGroupItem value="agent-prompt">Agent Prompt</ToggleGroupItem>
    </ToggleGroup>
  )
}
