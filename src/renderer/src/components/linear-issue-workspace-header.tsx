import React from 'react'
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Plus,
  X
} from 'lucide-react'

import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import { copyLinearIssueText } from './linear-issue-clipboard'

export function LinearIssueWorkspaceHeader({
  issue,
  issueLoading,
  attachedWorkspace,
  variant,
  backLabel,
  onClose,
  onOpenOrUseIssue,
  onUseIssue
}: {
  issue: LinearIssue
  issueLoading: boolean
  attachedWorkspace: boolean
  variant: 'sheet' | 'page'
  backLabel: string
  onClose: () => void
  onOpenOrUseIssue: () => void
  onUseIssue: () => void
}): React.JSX.Element {
  return (
    <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-border/60 px-5">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        {variant === 'page' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="-ml-2 shrink-0 gap-1.5"
            aria-label={backLabel}
          >
            <ChevronLeft className="size-4" />
            {backLabel}
          </Button>
        ) : null}
        <LinearIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">
          {issue.workspaceName ??
            translate('auto.components.LinearIssueWorkspace.65239a714b', 'Linear')}
        </span>
        <ChevronRight className="size-3.5 shrink-0" />
        <span className="shrink-0">
          {translate('auto.components.LinearIssueWorkspace.f63ef94ea8', 'Issues')}
        </span>
        <ChevronRight className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono">{issue.identifier}</span>
        <span className="min-w-0 truncate font-medium text-foreground">{issue.title}</span>
        {issueLoading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className="hidden px-2 text-sm text-muted-foreground md:inline">2 / 17</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void copyLinearIssueText(issue.url, 'URL')}
              aria-label={translate(
                'auto.components.LinearIssueWorkspace.97c19a84f1',
                'Copy Linear URL'
              )}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.LinearIssueWorkspace.9a9a884236', 'Copy URL')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void window.api.shell.openUrl(issue.url)}
              aria-label={translate(
                'auto.components.LinearIssueWorkspace.openOnLinear',
                'Open on Linear'
              )}
            >
              <ExternalLink className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.LinearIssueWorkspace.openOnLinear', 'Open on Linear')}
          </TooltipContent>
        </Tooltip>
        {attachedWorkspace ? (
          <DropdownMenu modal={false}>
            <ButtonGroup>
              <Button
                type="button"
                size="sm"
                onClick={onOpenOrUseIssue}
                className="gap-1.5 whitespace-nowrap"
                aria-label={translate(
                  'auto.components.LinearIssueWorkspace.openAttachedWorkspace',
                  'Open workspace attached to issue'
                )}
              >
                <FolderOpen className="size-3.5" />
                {translate('auto.components.LinearIssueWorkspace.openWorkspace', 'Open workspace')}
              </Button>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.LinearIssueWorkspace.moreWorkspaceActions',
                    'More issue workspace actions'
                  )}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </ButtonGroup>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onUseIssue}>
                <Plus className="size-4" />
                {translate(
                  'auto.components.LinearIssueWorkspace.startNewWorkspace',
                  'Start new workspace'
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={onOpenOrUseIssue}
            className="gap-1.5 whitespace-nowrap"
            aria-label={translate(
              'auto.components.LinearIssueWorkspace.30a7f56c0a',
              'Start workspace from issue'
            )}
          >
            {translate('auto.components.LinearIssueWorkspace.e1e0a9bca9', 'Start workspace')}
            <ArrowRight className="size-3.5" />
          </Button>
        )}
        {variant === 'sheet' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label={translate(
                  'auto.components.LinearIssueWorkspace.7a4997d8bb',
                  'Close Linear issue preview'
                )}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.LinearIssueWorkspace.df4c86ed12', 'Close')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </header>
  )
}
