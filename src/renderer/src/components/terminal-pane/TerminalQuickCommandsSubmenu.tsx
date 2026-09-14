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
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  getHostedTerminalQuickCommandKey,
  shouldShowTerminalQuickCommandHostOwnership,
  type TerminalQuickCommandMenuHost
} from '@/hooks/use-terminal-quick-command-hosts'

type TerminalQuickCommandsSubmenuProps = {
  hosts: TerminalQuickCommandMenuHost[]
  hostLoadFailed: boolean
  hostOwnershipPending: boolean
  repoLabel: string | null
  onAdd: (hostId: ExecutionHostId) => void
  onClose: () => void
  onRun: (command: TerminalQuickCommand, historyId: string) => void
}

export function TerminalQuickCommandsSubmenu({
  hosts,
  hostLoadFailed,
  hostOwnershipPending,
  repoLabel,
  onAdd,
  onClose,
  onRun
}: TerminalQuickCommandsSubmenuProps): React.JSX.Element {
  const nonEmptyHosts = hosts.filter(
    (host) => host.repoCommands.length > 0 || host.globalCommands.length > 0
  )
  const showHostOwnership = shouldShowTerminalQuickCommandHostOwnership(hosts)
  const singleHost = hosts[0]
  const renderCommand = (hostId: ExecutionHostId, command: TerminalQuickCommand) => (
    <DropdownMenuItem
      key={`${hostId}:${command.id}`}
      onSelect={() => onRun(command, getHostedTerminalQuickCommandKey(hostId, command.id))}
    >
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
        {nonEmptyHosts.length > 0 ? (
          showHostOwnership ? (
            nonEmptyHosts.map((host, index) => (
              <div key={host.hostId}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="truncate">{host.label}</DropdownMenuLabel>
                {[...host.repoCommands, ...host.globalCommands].map((command) =>
                  renderCommand(host.hostId, command)
                )}
              </div>
            ))
          ) : singleHost ? (
            <>
              {repoLabel && singleHost.repoCommands.length > 0 ? (
                <DropdownMenuLabel className="truncate">{repoLabel}</DropdownMenuLabel>
              ) : null}
              {singleHost.repoCommands.map((command) => renderCommand(singleHost.hostId, command))}
              {singleHost.repoCommands.length > 0 && singleHost.globalCommands.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>
                    {translate(
                      'auto.components.terminal.pane.TerminalContextMenu.3ce594a4a0',
                      'Global'
                    )}
                  </DropdownMenuLabel>
                </>
              ) : null}
              {singleHost.globalCommands.map((command) =>
                renderCommand(singleHost.hostId, command)
              )}
            </>
          ) : null
        ) : (
          <DropdownMenuItem disabled className="text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.9528a65ef8',
              'No quick commands'
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {hostOwnershipPending ? (
          <DropdownMenuItem disabled className="text-muted-foreground">
            {hostLoadFailed
              ? translate(
                  'auto.components.terminal.pane.TerminalQuickCommandsSubmenu.3ccc7981bb',
                  'Host unavailable'
                )
              : translate(
                  'auto.components.terminal.pane.TerminalQuickCommandsSubmenu.54f29b7c0d',
                  'Loading host…'
                )}
          </DropdownMenuItem>
        ) : (
          hosts.map((host) => (
            <DropdownMenuItem
              key={host.hostId}
              onSelect={() => {
                // Force-close the dropdown before its add dialog mounts above it.
                onClose()
                onAdd(host.hostId)
              }}
            >
              <Plus />
              {hosts.length === 1
                ? translate(
                    'auto.components.terminal.pane.TerminalContextMenu.0a82b0608c',
                    'Add Quick Command…'
                  )
                : translate(
                    'auto.components.terminal.pane.TerminalContextMenu.15dd899676',
                    'Add to {{value0}}…',
                    { value0: host.label }
                  )}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
