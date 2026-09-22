import React from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDashed,
  CircleDot,
  Copy,
  ExternalLink,
  FolderKanban,
  Plus
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseOwnerRepoFromItemUrl } from '@/components/github/github-work-item-identity'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { WorkItemIssueSourceIndicator } from './work-item-issue-source-indicator'

export function GitHubItemDialogIssueHeader({
  workItem,
  backLabel,
  onClose,
  linkCopied,
  setLinkCopyButtonRef,
  handleCopyWorkItemLink,
  issueAttachedWorkspace,
  handleOpenOrUseIssueWorkspace,
  onUse,
  localState,
  effectiveRepoId,
  repoPath,
  issueAttachedWorkspaceLabel
}: {
  workItem: GitHubWorkItem
  backLabel: string
  onClose: () => void
  linkCopied: boolean
  setLinkCopyButtonRef: (node: HTMLButtonElement | null) => void
  handleCopyWorkItemLink: () => Promise<void>
  issueAttachedWorkspace: object | null
  handleOpenOrUseIssueWorkspace: (item: GitHubWorkItem) => void
  onUse: (item: GitHubWorkItem) => void
  localState: GitHubWorkItem['state']
  effectiveRepoId: string | null
  repoPath: string | null
  issueAttachedWorkspaceLabel: string | null
}): React.JSX.Element {
  const ownerRepo = parseOwnerRepoFromItemUrl(workItem.url)
  const issueStateBadgeTone =
    localState === 'closed' ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'

  return (
    <>
      <div className="flex-none border-b border-border/60 bg-muted/30 px-6 py-2.5">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
            aria-label={backLabel}
          >
            <ChevronLeft className="size-4" />
            {backLabel}
          </Button>
          <span className="text-border">·</span>
          {ownerRepo ? (
            <>
              <span className="truncate">
                <span className="text-muted-foreground">{ownerRepo.owner}</span>
                <span className="mx-1 text-muted-foreground/60">/</span>
                <span className="font-medium text-foreground">{ownerRepo.repo}</span>
              </span>
              <span className="text-muted-foreground/60">·</span>
            </>
          ) : null}
          <span className="font-mono text-muted-foreground">#{workItem.number}</span>
          <div className="ml-auto flex items-center gap-1">
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

      <div className="flex-none border-b border-border/60 bg-card px-6 py-4">
        <div className="flex items-start gap-4">
          <h1 className="min-w-0 flex-1 text-[28px] font-medium leading-tight text-foreground">
            <span className="break-words">{workItem.title}</span>
            <span className="ml-2 font-light text-muted-foreground">#{workItem.number}</span>
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {/* Why: Orca's signature affordance — keep primary so it stands out against GitHub's familiar surface. */}
            {issueAttachedWorkspace ? (
              <DropdownMenu modal={false}>
                <ButtonGroup>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleOpenOrUseIssueWorkspace(workItem)}
                    className="gap-1.5 whitespace-nowrap"
                    aria-label={translate(
                      'auto.components.GitHubItemDialog.84855fedd0',
                      'Open workspace attached to issue'
                    )}
                  >
                    {translate('auto.components.GitHubItemDialog.726db41722', 'Open workspace')}
                    <ArrowRight className="size-3.5" />
                  </Button>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      aria-label={translate(
                        'auto.components.GitHubItemDialog.fe6ff12dc2',
                        'More issue workspace actions'
                      )}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </ButtonGroup>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onUse(workItem)}>
                    <Plus className="size-4" />
                    {translate(
                      'auto.components.GitHubItemDialog.36182aa57f',
                      'Start new workspace'
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => window.api.shell.openUrl(workItem.url)}>
                    <ExternalLink className="size-4" />
                    {translate('auto.components.GitHubItemDialog.3fdf777817', 'Open on GitHub')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => onUse(workItem)}
                className="gap-1.5 whitespace-nowrap"
                aria-label={translate(
                  'auto.components.GitHubItemDialog.0ab4664a8b',
                  'Start workspace from issue'
                )}
              >
                {translate(
                  'auto.components.GitHubItemDialog.0ab4664a8b',
                  'Start workspace from issue'
                )}
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
              issueStateBadgeTone
            )}
          >
            {localState === 'closed' ? (
              <CircleDashed className="size-3.5" />
            ) : (
              <CircleDot className="size-3.5" />
            )}
            {localState === 'closed'
              ? translate('auto.components.GitHubItemDialog.ab050dffec', 'Closed')
              : translate('auto.components.GitHubItemDialog.dc1ca081a8', 'Open')}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-foreground">
              {workItem.author ??
                translate('auto.components.GitHubItemDialog.773ff70035', 'unknown')}
            </span>
            <span>
              {translate('auto.components.GitHubItemDialog.55962099bc', 'opened this issue')}
            </span>
            <span className="text-muted-foreground/80">
              {translate('auto.components.GitHubItemDialog.10ef1afb8e', '· updated')}{' '}
              {formatRelativeTime(workItem.updatedAt)}
            </span>
          </span>
          <WorkItemIssueSourceIndicator
            url={workItem.url}
            repoId={effectiveRepoId}
            repoPath={repoPath}
          />
          {issueAttachedWorkspaceLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <FolderKanban className="size-3.5 shrink-0" />
              <span className="truncate">{issueAttachedWorkspaceLabel}</span>
            </span>
          ) : null}
        </div>
      </div>
    </>
  )
}
