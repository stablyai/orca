import { Check, Copy, Pencil, TerminalSquare, Trash2 } from 'lucide-react'
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
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
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

function getRunModeLabel(command: TerminalQuickCommand): string {
  if (isTerminalAgentQuickCommand(command)) {
    return translate('auto.components.settings.QuickCommandsPane.4ccc63da87', 'Agent')
  }
  return command.appendEnter
    ? translate('auto.components.settings.QuickCommandsPane.9b3e338d62', 'Enter')
    : translate('auto.components.settings.QuickCommandsPane.9fcfc29519', 'Insert')
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
  const body = getTerminalQuickCommandBody(command)
  const { canCopy, copyText, status } = useClipboardTextCopyFeedback(body)
  const commandName = command.label || 'quick command'

  const copyLabel =
    status === 'copied'
      ? translate('auto.components.settings.QuickCommandsPane.8d525e5f15', 'Copied')
      : status === 'failed'
        ? translate('auto.components.settings.QuickCommandsPane.53b17a4b1b', "Couldn't copy")
        : canCopy
          ? translate('auto.components.settings.QuickCommandsPane.a9a564b7e7', 'Copy {{value0}}', {
              value0: commandName
            })
          : translate('auto.components.settings.QuickCommandsPane.69a1441a21', 'Nothing to copy')
  const editLabel = translate(
    'auto.components.settings.QuickCommandsPane.7d90fd5299',
    'Edit {{value0}}',
    { value0: commandName }
  )

  return (
    <div className="group/qc flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/60 focus-within:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">
            {command.label ||
              translate('auto.components.settings.QuickCommandsPane.2bb9e38e93', 'Untitled')}
          </div>
          <Badge variant="outline" className="max-w-44 gap-1.5 text-[11px] font-normal">
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
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {isTerminalAgentQuickCommand(command) ? (
            <span className="shrink-0">
              <AgentIcon agent={command.agent} size={12} />
            </span>
          ) : null}
          <span className={cn('truncate', isTerminalAgentQuickCommand(command) ? '' : 'font-mono')}>
            {isTerminalAgentQuickCommand(command)
              ? `${getAgentLabel(command.agent)}: ${body}`
              : body ||
                translate(
                  'auto.components.settings.QuickCommandsPane.0252ddd578',
                  'No command text'
                )}
          </span>
        </div>
      </div>
      <div className="w-12 shrink-0 text-right text-[11px] text-muted-foreground">
        {getRunModeLabel(command)}
      </div>
      {/* Why can-hover: touch devices never hover, so the actions must stay visible there. */}
      <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/qc:opacity-100 group-focus-within/qc:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={editLabel}
          title={editLabel}
          onClick={() => onEdit(command)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!canCopy}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copyText()}
          className={cn(
            status === 'copied' && 'text-status-success',
            status === 'failed' && 'text-destructive'
          )}
        >
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate(
            'auto.components.settings.QuickCommandsPane.8764c6e9e4',
            'Remove {{value0}}',
            { value0: commandName }
          )}
          onClick={() => onRemove(command)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

function QuickCommandsEmptyState({
  hasCommands,
  hasQuery
}: {
  hasCommands: boolean
  hasQuery: boolean
}): React.JSX.Element {
  if (hasCommands) {
    return (
      <div className="px-2 py-10 text-center text-sm text-muted-foreground">
        {hasQuery
          ? translate(
              'auto.components.settings.QuickCommandsList.noSearchMatches',
              'No commands match this search.'
            )
          : translate(
              'auto.components.settings.QuickCommandsPane.3eb9897ab0',
              'No commands in the selected scopes.'
            )}
      </div>
    )
  }
  // Why no action here: the toolbar's Add Command sits directly above.
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
      <TerminalSquare className="size-7 text-muted-foreground/50" />
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.QuickCommandsPane.38d61927e6',
            'No quick commands saved.'
          )}
        </p>
        <p className="text-xs text-muted-foreground/80">
          {translate(
            'auto.components.settings.QuickCommandsPane.c36912efd5',
            'Run them from the Quick Commands button in the tab bar, or right-click inside any terminal.'
          )}
        </p>
      </div>
    </div>
  )
}

export function QuickCommandsList({
  commands,
  visibleCommands,
  hasQuery,
  repoById,
  onEdit,
  onRemove
}: {
  commands: TerminalQuickCommand[]
  visibleCommands: TerminalQuickCommand[]
  hasQuery: boolean
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
  onEdit: (command: TerminalQuickCommand) => void
  onRemove: (command: TerminalQuickCommand) => void
}): React.JSX.Element {
  if (visibleCommands.length === 0) {
    return <QuickCommandsEmptyState hasCommands={commands.length > 0} hasQuery={hasQuery} />
  }
  return (
    <div className="-mx-2 divide-y divide-border/50">
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
  )
}
