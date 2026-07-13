import { Play, Plus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'

type TerminalContextMenuQuickCommandsProps = {
  repoQuickCommands: TerminalQuickCommand[]
  projectQuickCommands: TerminalQuickCommand[]
  globalQuickCommands: TerminalQuickCommand[]
  quickCommandRepoLabel: string | null
  onQuickCommand: (command: TerminalQuickCommand) => void
  onAddQuickCommand: () => void
  onMenuOpenChange: (open: boolean) => void
}

export function TerminalContextMenuQuickCommands({
  repoQuickCommands,
  projectQuickCommands,
  globalQuickCommands,
  quickCommandRepoLabel,
  onQuickCommand,
  onAddQuickCommand,
  onMenuOpenChange
}: TerminalContextMenuQuickCommandsProps): React.JSX.Element {
  const hasQuickCommands =
    repoQuickCommands.length > 0 ||
    projectQuickCommands.length > 0 ||
    globalQuickCommands.length > 0
  const renderQuickCommandItem = (command: TerminalQuickCommand): React.JSX.Element => (
    <DropdownMenuItem key={command.id} onSelect={() => onQuickCommand(command)}>
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

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Play fill="currentColor" strokeWidth={0} />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.ec85df5914',
          'Quick Commands'
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {hasQuickCommands ? (
          <>
            {quickCommandRepoLabel && repoQuickCommands.length > 0 ? (
              <>
                <DropdownMenuLabel className="truncate">{quickCommandRepoLabel}</DropdownMenuLabel>
                {repoQuickCommands.map(renderQuickCommandItem)}
              </>
            ) : null}
            {projectQuickCommands.length > 0 ? (
              <>
                {repoQuickCommands.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="truncate">
                  {translate(
                    'auto.components.terminal.pane.TerminalContextMenu.5b2ac41d87',
                    'Project — orca.yaml'
                  )}
                </DropdownMenuLabel>
                {projectQuickCommands.map(renderQuickCommandItem)}
              </>
            ) : null}
            {globalQuickCommands.length > 0 ? (
              <>
                {repoQuickCommands.length + projectQuickCommands.length > 0 ? (
                  <DropdownMenuSeparator />
                ) : null}
                {repoQuickCommands.length + projectQuickCommands.length > 0 ? (
                  <DropdownMenuLabel>
                    {translate(
                      'auto.components.terminal.pane.TerminalContextMenu.3ce594a4a0',
                      'Global'
                    )}
                  </DropdownMenuLabel>
                ) : null}
                {globalQuickCommands.map(renderQuickCommandItem)}
              </>
            ) : null}
          </>
        ) : (
          <DropdownMenuItem disabled className="text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.9528a65ef8',
              'No quick commands'
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            // Why: the dropdown sits above dialogs; force-close before
            // opening the add modal even during the open-gesture guard.
            onMenuOpenChange(false)
            onAddQuickCommand()
          }}
        >
          <Plus />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.0a82b0608c',
            'Add Quick Command…'
          )}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
