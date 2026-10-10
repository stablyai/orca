import React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  ExternalLink,
  FolderKanban,
  Plus
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { parseOwnerRepoFromItemUrl } from '@/components/github/github-work-item-identity'
import { formatRelativeTime, getStateLabel } from '@/components/github/work-item-state-presentation'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getSolidStateTone } from '../presentation/state-badge'

export function PullRequestPageHeader({
  workItem,
  displayWorkItem,
  backLabel,
  onClose,
  linkCopied,
  setLinkCopyButtonRef,
  onCopyLink,
  hasAttachedWorkspace,
  attachedWorkspaceLabel,
  localState,
  Icon,
  onOpenOrUsePR,
  onUseWorkItem
}: {
  workItem: GitHubWorkItem
  displayWorkItem: GitHubWorkItem | null
  backLabel: string
  onClose: () => void
  linkCopied: boolean
  setLinkCopyButtonRef: (node: HTMLButtonElement | null) => void
  onCopyLink: () => void
  hasAttachedWorkspace: boolean
  attachedWorkspaceLabel: string | null
  localState: GitHubWorkItem['state']
  Icon: React.ComponentType<{ className?: string }>
  onOpenOrUsePR: () => void
  onUseWorkItem: () => void
}): React.JSX.Element {
  const ownerRepo = parseOwnerRepoFromItemUrl(workItem.url)
  const headBranch = workItem.branchName
  const baseBranch = workItem.baseRefName
  const stateBadgeItem = { ...workItem, state: localState }
  const stateBadgeTone = getSolidStateTone(stateBadgeItem)
  const stateBadgeLabel = getStateLabel(stateBadgeItem)

  return (
    <>
      {/* Row 1: page header strip — breadcrumb-style row mirroring Primer canvas-subtle */}
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
          <span className="text-muted-foreground/40">·</span>
          {ownerRepo ? (
            <>
              <span className="truncate">
                <span className="text-muted-foreground">{ownerRepo.owner}</span>
                <span className="mx-1 text-muted-foreground/40">/</span>
                <span className="font-medium text-foreground">{ownerRepo.repo}</span>
              </span>
              <span className="text-muted-foreground/40">·</span>
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
                  onClick={onCopyLink}
                  aria-label={translate(
                    'auto.components.PullRequestPage.347034903a',
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
                  ? translate('auto.components.PullRequestPage.3b6886b2ee', 'Copied')
                  : translate('auto.components.PullRequestPage.347034903a', 'Copy GitHub link')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => window.api.shell.openUrl(workItem.url)}
                  aria-label={translate(
                    'auto.components.PullRequestPage.8ecda455a0',
                    'Open on GitHub'
                  )}
                >
                  <ExternalLink className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.PullRequestPage.8ecda455a0', 'Open on GitHub')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Row 2: PR title block — large weight-400 title + state row, mirrors Primer pr-title-block */}
      <div className="flex-none border-b border-border/60 px-6 py-5">
        <div className="flex items-start gap-4">
          <h1 className="min-w-0 flex-1 text-[26px] font-medium leading-snug text-foreground">
            <span className="break-words">{workItem.title}</span>
            <span className="ml-2 align-baseline text-[20px] font-normal text-muted-foreground/70">
              #{workItem.number}
            </span>
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {/* Why: Orca's signature affordance — keep primary so it stands out against GitHub's familiar surface. */}
            <DropdownMenu modal={false}>
              <ButtonGroup>
                <Button
                  type="button"
                  onClick={onOpenOrUsePR}
                  className="w-[180px] justify-center gap-1.5 whitespace-nowrap"
                  aria-label={
                    hasAttachedWorkspace
                      ? translate(
                          'auto.components.PullRequestPage.a459866967',
                          'Resume workspace attached to PR'
                        )
                      : translate(
                          'auto.components.PullRequestPage.25690a3855',
                          'Start workspace from PR'
                        )
                  }
                >
                  {hasAttachedWorkspace
                    ? translate('auto.components.PullRequestPage.c9e7094a7b', 'Resume workspace')
                    : translate('auto.components.PullRequestPage.71a3c0f9d2', 'Start workspace')}
                  <ArrowRight className="size-4" />
                </Button>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    aria-label={translate(
                      'auto.components.PullRequestPage.57c13a5aa4',
                      'More PR workspace actions'
                    )}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </ButtonGroup>
              <DropdownMenuContent align="end">
                {hasAttachedWorkspace ? (
                  <DropdownMenuItem onSelect={onUseWorkItem}>
                    <Plus className="size-4" />
                    {translate('auto.components.PullRequestPage.1a2570e18e', 'Start new workspace')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => window.api.shell.openUrl(workItem.url)}>
                  <ExternalLink className="size-4" />
                  {translate('auto.components.PullRequestPage.8ecda455a0', 'Open on GitHub')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-muted-foreground">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
              stateBadgeTone
            )}
          >
            <Icon className="size-3.5" />
            {stateBadgeLabel}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {workItem.author ? (
              <GitHubUserAvatar
                login={workItem.author}
                avatarUrl={displayWorkItem?.authorAvatarUrl ?? workItem.authorAvatarUrl}
                className="size-5"
              />
            ) : null}
            <span className="font-semibold text-foreground">
              {workItem.author ??
                translate('auto.components.PullRequestPage.77d9388fb0', 'unknown')}
            </span>
          </span>
          {/* Why: base ← head scans faster than prose and matches how reviewers think about merge direction. */}
          <span className="flex flex-wrap items-center gap-1.5">
            {baseBranch ? (
              <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                {baseBranch}
              </span>
            ) : (
              <span className="italic">
                {translate('auto.components.PullRequestPage.c44b70352b', 'base branch')}
              </span>
            )}
            <ArrowLeft className="size-3.5 shrink-0 text-muted-foreground/70" />
            {headBranch ? (
              <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                {headBranch}
              </span>
            ) : (
              <span className="italic">
                {translate('auto.components.PullRequestPage.00b7b82329', 'head branch')}
              </span>
            )}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-muted-foreground/80">
            {translate('auto.components.PullRequestPage.dd5d9a4f17', 'updated {{value0}}', {
              value0: formatRelativeTime(workItem.updatedAt)
            })}
          </span>
          {attachedWorkspaceLabel ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FolderKanban className="size-3.5 shrink-0" />
                <span className="truncate">{attachedWorkspaceLabel}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}
