import { Pencil, Trash2 } from 'lucide-react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import {
  getTerminalQuickCommandBody,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { RepoBadgeMark } from '../repo/RepoBadgeLabel'
import { getQuickCommandRepoLabel } from './QuickCommandsScopeFilter'

function getScopeLabel(
  scope: TerminalQuickCommandScope,
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
): string {
  if (scope.type === 'global') {
    return 'Global'
  }
  const repo = repoById.get(scope.repoId)
  return repo ? getQuickCommandRepoLabel(repo) : 'Missing project'
}

function QuickCommandRow({
  command,
  repoById,
  onEdit,
  onRemove
}: {
  command: TerminalQuickCommand
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
  onEdit: (command: TerminalQuickCommand) => void
  onRemove: (command: TerminalQuickCommand) => void
}): React.JSX.Element {
  const scope = getTerminalQuickCommandScope(command)
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2 shadow-xs">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">
            {command.label ||
              translate('auto.components.settings.QuickCommandsPane.2bb9e38e93', 'Untitled')}
          </div>
          <Badge variant="outline" className="max-w-44 gap-1.5">
            {scope.type === 'repo' ? (
              <>
                <RepoBadgeMark color={repoById.get(scope.repoId)?.badgeColor} />
                <span className="truncate">{getScopeLabel(scope, repoById)}</span>
              </>
            ) : (
              <span className="truncate">{getScopeLabel(scope, repoById)}</span>
            )}
          </Badge>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/80">
          {isTerminalAgentQuickCommand(command) ? (
            <span className="shrink-0 text-muted-foreground">
              <AgentIcon agent={command.agent} size={12} />
            </span>
          ) : null}
          <span className={cn('truncate', isTerminalAgentQuickCommand(command) ? '' : 'font-mono')}>
            {isTerminalAgentQuickCommand(command)
              ? `${getAgentLabel(command.agent)}: ${getTerminalQuickCommandBody(command)}`
              : getTerminalQuickCommandBody(command) ||
                translate(
                  'auto.components.settings.QuickCommandsPane.0252ddd578',
                  'No command text'
                )}
          </span>
        </div>
      </div>
      <div className="shrink-0 text-[11px] font-medium text-foreground/75">
        {isTerminalAgentQuickCommand(command)
          ? translate('auto.components.settings.QuickCommandsPane.4ccc63da87', 'Agent')
          : command.appendEnter
            ? translate('auto.components.settings.QuickCommandsPane.9b3e338d62', 'Enter')
            : translate('auto.components.settings.QuickCommandsPane.9fcfc29519', 'Insert')}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.QuickCommandsPane.7d90fd5299',
          'Edit {{value0}}',
          {
            value0: command.label || 'quick command'
          }
        )}
        onClick={() => onEdit(command)}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.QuickCommandsPane.8764c6e9e4',
          'Remove {{value0}}',
          {
            value0: command.label || 'quick command'
          }
        )}
        onClick={() => onRemove(command)}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </div>
  )
}

export function QuickCommandsList({
  commands,
  visibleCommands,
  repoById,
  onEdit,
  onRemove
}: {
  commands: TerminalQuickCommand[]
  visibleCommands: TerminalQuickCommand[]
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
  onEdit: (command: TerminalQuickCommand) => void
  onRemove: (command: TerminalQuickCommand) => void
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
      {visibleCommands.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          {commands.length === 0
            ? translate(
                'auto.components.settings.QuickCommandsPane.38d61927e6',
                'No quick commands saved.'
              )
            : translate(
                'auto.components.settings.QuickCommandsPane.3eb9897ab0',
                'No commands in the selected scopes.'
              )}
        </div>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2 scrollbar-sleek">
          {visibleCommands.map((command) => (
            <QuickCommandRow
              key={command.id}
              command={command}
              repoById={repoById}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
}
