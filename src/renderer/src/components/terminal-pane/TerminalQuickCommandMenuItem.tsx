import { Play } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'

type TerminalQuickCommandMenuItemProps = {
  command: TerminalQuickCommand
  onSelect: (command: TerminalQuickCommand) => void
}

export function TerminalQuickCommandMenuItem({
  command,
  onSelect
}: TerminalQuickCommandMenuItemProps): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={() => onSelect(command)}>
      {isTerminalAgentQuickCommand(command) ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <AgentIcon agent={command.agent} size={14} />
        </span>
      ) : (
        <Play
          className="size-3.5 shrink-0 text-muted-foreground"
          fill="currentColor"
          strokeWidth={0}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {!isTerminalAgentQuickCommand(command) && !command.appendEnter ? (
        <DropdownMenuShortcut className="shrink-0">
          {translate('auto.components.terminal.pane.TerminalContextMenu.c2f0b72b8d', 'Insert')}
        </DropdownMenuShortcut>
      ) : null}
    </DropdownMenuItem>
  )
}
