import React from 'react'
import { ExternalLink, GitPullRequest, Terminal, Ticket, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { WorkspaceAttachmentOrigins } from './WorkspaceAttachmentOrigins'
import {
  workspaceAttachmentLabel,
  workspaceAttachmentProviderLabel
} from './worktree-attachment-editing'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'

type Props = {
  item: WorkspaceAttachment
  workspace?: Worktree
  disabled: boolean
  onRemove: () => void
}

export function WorktreeLinkedItemRow({
  item,
  workspace,
  disabled,
  onRemove
}: Props): React.JSX.Element {
  const label = workspaceAttachmentLabel(item)
  const source = getWorkspaceAttachmentSourceLabel(item)
  const provider = workspaceAttachmentProviderLabel(item)
  const observedCount = item.origins?.filter((origin) => origin.kind === 'observed').length ?? 0
  const sessionsLabel = translate('workspace.links.sessions', 'Sessions & terminals')
  return (
    <Collapsible
      data-workspace-linked-item=""
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
          event.stopPropagation()
        }
      }}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1 py-1">
        {item.type === 'issue' ? (
          <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
              <span className="shrink-0 font-medium">{label}</span>
              {item.title ? (
                <span className="truncate text-muted-foreground">{item.title}</span>
              ) : null}
              <span className="sr-only">
                {provider}
                {source ? ` · ${source}` : ''}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <p>{item.title || label}</p>
            <p>
              {label} · {provider}
              {source ? ` · ${source}` : ''}
            </p>
          </TooltipContent>
        </Tooltip>
        {workspace && observedCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  aria-label={translate(
                    'workspace.links.sessionsForItem',
                    'Sessions & terminals for {{label}} · {{count}}',
                    { label, count: observedCount }
                  )}
                >
                  <Terminal className="size-3" />
                  <span>{observedCount}</span>
                </Button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            <TooltipContent>{sessionsLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {item.url ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate('workspace.links.openItem', 'Open {{label}}', { label })}
                onClick={() => void window.api.shell.openUrl(item.url ?? '')}
              >
                <ExternalLink className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translate('workspace.links.open', 'Open link')}</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={translate('workspace.links.unlinkItem', 'Unlink {{label}}', { label })}
              onClick={onRemove}
            >
              <X className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('workspace.links.unlink', 'Unlink from workspace')}
          </TooltipContent>
        </Tooltip>
      </div>
      {workspace && observedCount > 0 ? (
        <CollapsibleContent>
          <div className="text-xs">
            <WorkspaceAttachmentOrigins item={item} workspace={workspace} />
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}
