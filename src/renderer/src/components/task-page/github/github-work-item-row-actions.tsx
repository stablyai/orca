import React from 'react'
import { ArrowRight, ChevronDown, EllipsisVertical, ExternalLink, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Worktree } from '../../../../../shared/worktree/types'

export function GithubWorkItemRowActions({
  item,
  attachedWorkspace,
  handleOpenOrUseGitHubWorkItem,
  handleUseWorkItem
}: {
  item: GitHubWorkItem
  attachedWorkspace: Worktree | null
  handleOpenOrUseGitHubWorkItem: (item: GitHubWorkItem) => void
  handleUseWorkItem: (item: GitHubWorkItem) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-start gap-1 lg:justify-end">
      {item.type === 'pr' ? (
        <DropdownMenu modal={false}>
          <ButtonGroup>
            <Button
              type="button"
              variant={attachedWorkspace ? 'default' : 'outline'}
              size="xs"
              data-contextual-tour-target="tasks-start-workspace"
              onClick={(event) => {
                event.stopPropagation()
                handleOpenOrUseGitHubWorkItem(item)
              }}
              className={cn(
                'min-w-[72px] gap-1 font-semibold',
                attachedWorkspace ? 'shadow-xs' : 'bg-background/80'
              )}
              aria-label={
                attachedWorkspace
                  ? translate(
                      'auto.components.TaskPage.67d881244c',
                      'Resume workspace attached to PR'
                    )
                  : translate('auto.components.TaskPage.e4b29c5bcf', 'Start workspace from PR')
              }
            >
              {attachedWorkspace
                ? translate('auto.components.TaskPage.7753652524', 'Resume')
                : translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
              <ArrowRight className="size-3" />
            </Button>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant={attachedWorkspace ? 'default' : 'outline'}
                size="icon-xs"
                onClick={(event) => event.stopPropagation()}
                className={cn(attachedWorkspace ? 'shadow-xs' : 'bg-background/80')}
                aria-label={translate('auto.components.TaskPage.7deb9e59a5', 'More PR actions')}
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </ButtonGroup>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            {attachedWorkspace ? (
              <DropdownMenuItem onSelect={() => handleUseWorkItem(item)}>
                <Plus className="size-4" />
                {translate('auto.components.TaskPage.b6329379ca', 'Start new workspace')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
              <ExternalLink className="size-4" />
              {translate('auto.components.TaskPage.c1d1600362', 'Open in browser')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          // Why: Open resumes an existing workspace — solid primary reads stronger than outline Start (new workspace).
          variant={attachedWorkspace ? 'default' : 'outline'}
          size="xs"
          data-contextual-tour-target="tasks-start-workspace"
          onClick={(event) => {
            event.stopPropagation()
            handleOpenOrUseGitHubWorkItem(item)
          }}
          className={cn(
            'min-w-[72px] gap-1 font-semibold',
            attachedWorkspace ? 'shadow-xs' : 'bg-background/80'
          )}
          aria-label={
            attachedWorkspace
              ? translate('auto.components.TaskPage.2193a99ec1', 'Open workspace attached to issue')
              : translate('auto.components.TaskPage.e104fa3d3d', 'Start workspace from issue')
          }
        >
          {attachedWorkspace
            ? translate('auto.components.TaskPage.606a85c774', 'Open')
            : translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
          <ArrowRight className="size-3" />
        </Button>
      )}
      {item.type !== 'pr' ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
              aria-label={translate('auto.components.TaskPage.66ae7330f6', 'More actions')}
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {attachedWorkspace ? (
              <DropdownMenuItem onSelect={() => handleUseWorkItem(item)}>
                <Plus className="size-4" />
                {translate('auto.components.TaskPage.b6329379ca', 'Start new workspace')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(item.url)}>
              <ExternalLink className="size-4" />
              {translate('auto.components.TaskPage.c1d1600362', 'Open in browser')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
