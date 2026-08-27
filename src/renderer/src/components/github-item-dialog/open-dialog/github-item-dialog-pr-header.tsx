import React from 'react'
import {
  ArrowRight,
  Check,
  ChevronLeft,
  CircleDot,
  Copy,
  ExternalLink,
  FolderKanban,
  GitPullRequest
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { WorkItemIssueSourceIndicator } from './work-item-issue-source-indicator'
import { WorkItemStateBadge } from '../load-item-details/work-item-state-badge'

export function GitHubItemDialogPRHeader({
  workItem,
  backLabel,
  onClose,
  localState,
  issueAttachedWorkspaceLabel,
  effectiveRepoId,
  repoPath,
  onUse,
  linkCopied,
  setLinkCopyButtonRef,
  handleCopyWorkItemLink
}: {
  workItem: GitHubWorkItem
  backLabel: string
  onClose: () => void
  localState: GitHubWorkItem['state']
  issueAttachedWorkspaceLabel: string | null
  effectiveRepoId: string | null
  repoPath: string | null
  onUse: (item: GitHubWorkItem) => void
  linkCopied: boolean
  setLinkCopyButtonRef: (node: HTMLButtonElement | null) => void
  handleCopyWorkItemLink: () => Promise<void>
}): React.JSX.Element {
  const Icon = workItem.type === 'pr' ? GitPullRequest : CircleDot

  return (
    <div className="flex-none border-b border-border/60 bg-card/80 px-4 py-3 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/70">
      <div className="flex items-start gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="-ml-1 mt-0.5 shrink-0 gap-1.5"
          aria-label={backLabel}
        >
          <ChevronLeft className="size-4" />
          {backLabel}
        </Button>
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <WorkItemStateBadge item={{ ...workItem, state: localState }} />
            <span className="font-mono">#{workItem.number}</span>
            <span>
              {workItem.type === 'pr'
                ? translate('auto.components.GitHubItemDialog.a2495e4784', 'Pull request')
                : translate('auto.components.GitHubItemDialog.3e544d966d', 'Issue')}
            </span>
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">
            {workItem.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {workItem.author ??
                translate('auto.components.GitHubItemDialog.773ff70035', 'unknown')}
            </span>
            <span>
              {translate('auto.components.GitHubItemDialog.8223320f8d', 'updated')}{' '}
              {formatRelativeTime(workItem.updatedAt)}
            </span>
            {workItem.branchName && (
              <span className="max-w-full truncate rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {workItem.branchName}
              </span>
            )}
            {issueAttachedWorkspaceLabel ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <FolderKanban className="size-3 shrink-0" />
                <span className="truncate">{issueAttachedWorkspaceLabel}</span>
              </span>
            ) : null}
          </div>
          {workItem.type === 'issue' && (
            <WorkItemIssueSourceIndicator
              url={workItem.url}
              repoId={effectiveRepoId}
              repoPath={repoPath}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          {workItem.type === 'pr' && (
            <Button
              type="button"
              size="sm"
              onClick={() => onUse(workItem)}
              className="gap-1.5 whitespace-nowrap"
              aria-label={translate(
                'auto.components.GitHubItemDialog.0caac1a18f',
                'Start workspace from PR'
              )}
            >
              {translate('auto.components.GitHubItemDialog.0caac1a18f', 'Start workspace from PR')}
              <ArrowRight className="size-3.5" />
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={setLinkCopyButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleCopyWorkItemLink()}
                aria-label={translate(
                  'auto.components.GitHubItemDialog.c43fe79ee0',
                  'Copy GitHub link'
                )}
              >
                {linkCopied ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {linkCopied
                ? translate('auto.components.GitHubItemDialog.038b3d39b1', 'Copied')
                : translate('auto.components.GitHubItemDialog.c43fe79ee0', 'Copy GitHub link')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => window.api.shell.openUrl(workItem.url)}
                aria-label={translate(
                  'auto.components.GitHubItemDialog.3fdf777817',
                  'Open on GitHub'
                )}
              >
                <ExternalLink className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.GitHubItemDialog.3fdf777817', 'Open on GitHub')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
