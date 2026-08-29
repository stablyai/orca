import React from 'react'
import { CircleDot, Files, FolderKanban, GitPullRequest, GitPullRequestDraft } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import {
  getTaskPageGitHubPRIconTone,
  isTaskPageGitHubDraftPR
} from '@/components/task-page-github-work-item-status'
import { TaskPageGitHubWorkItemStateBadge } from '@/components/task-page-github-work-item-status-badge'
import { formatPRDelta } from '@/components/task-page-pr-delta-summary'
import type { ItemDialogTab } from '@/components/GitHubItemDialog'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { findGithubWorkItemWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  GITHUB_TASK_STICKY_ID_CELL_CLASS,
  GITHUB_TASK_STICKY_TITLE_CELL_CLASS
} from './github-task-surface-classes'
import { GHAssigneesCell } from './github-assignees-cell'
import { GHStatusCell } from './github-status-cell'
import { PRChecksCell } from './pr-checks-cell'
import { PRMergeCell } from './pr-merge-cell'
import { PRReviewCell } from './pr-review-cell'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'
import { GithubWorkItemRowActions } from './github-work-item-row-actions'
import { getTaskPageRepoSourceContext } from '../source/repo-source-context'
import { formatRelativeTime } from '../relative-time'

export type GithubWorkItemRowProps = {
  item: GitHubWorkItem
  itemRepo: Repo | null
  allWorktrees: readonly Worktree[]
  selectedRepoCount: number
  showPRManagementColumns: boolean
  githubTaskGridClass: string
  openGitHubDetailPage: (item: GitHubWorkItem, tab?: ItemDialogTab) => void
  githubWorkItemMutation: TaskPageGitHubWorkItemMutationRunner
  ensurePRChecksLoaded: (item: GitHubWorkItem) => void
  handleOpenOrUseGitHubWorkItem: (item: GitHubWorkItem) => void
  handleUseWorkItem: (item: GitHubWorkItem) => void
}

export function GithubWorkItemRow({
  item,
  itemRepo,
  allWorktrees,
  selectedRepoCount,
  showPRManagementColumns,
  githubTaskGridClass,
  openGitHubDetailPage,
  githubWorkItemMutation,
  ensurePRChecksLoaded,
  handleOpenOrUseGitHubWorkItem,
  handleUseWorkItem
}: GithubWorkItemRowProps): React.JSX.Element {
  const attachedWorkspace = findGithubWorkItemWorkspaceAttachment(
    allWorktrees,
    item.repoId,
    item.type,
    item.number
  )
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null
  const prDelta = item.type === 'pr' ? formatPRDelta(item) : null
  const rowSourceContext = getTaskPageRepoSourceContext(itemRepo, 'github')
  const githubTaskIdPill = (
    <span
      // Why: no fill — a muted wash on the pill stacks on the
      // row's hover:bg-accent and reads as a second hover tint.
      className="inline-flex items-center gap-1 rounded-md border border-border/40 px-1.5 py-0.5 text-muted-foreground"
      aria-label={`${
        item.type === 'pr'
          ? isTaskPageGitHubDraftPR(item)
            ? translate(
                'auto.components.task.page.github.github.work.item.row.draftPullRequest',
                'Draft pull request'
              )
            : translate(
                'auto.components.task.page.github.github.work.item.row.pullRequest',
                'Pull request'
              )
          : translate('auto.components.task.page.github.github.work.item.row.issue', 'Issue')
      } #${item.number}`}
    >
      {item.type === 'pr' ? (
        isTaskPageGitHubDraftPR(item) ? (
          <GitPullRequestDraft
            className={cn('size-3', getTaskPageGitHubPRIconTone(item))}
            aria-hidden="true"
          />
        ) : (
          <GitPullRequest
            className={cn('size-3', getTaskPageGitHubPRIconTone(item))}
            aria-hidden="true"
          />
        )
      ) : (
        <CircleDot className="size-3" aria-hidden="true" />
      )}
      <span className="font-mono text-[11px] font-normal">#{item.number}</span>
    </span>
  )

  return (
    // Why: clickable div not a <button> — it nests buttons, and button-in-button is invalid HTML that breaks hydration.
    <div
      // Why: key on repoId+item.id — repos sharing an upstream reuse item.id, so a bare key collides and React silently drops rows.
      role="button"
      tabIndex={0}
      onClick={() => openGitHubDetailPage(item)}
      onKeyDown={(event) => {
        // Why: keydown bubbles from the row's nested action buttons; activating those must not also open the detail page.
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openGitHubDetailPage(item)
        }
      }}
      className={cn(
        // Why: sticky ID/Title paint the same bg-background /
        // hover:bg-accent pair (with transition-colors) so the
        // left columns don't flash a separate hover wash.
        // Grid stretch (default) keeps sticky fills full-height.
        'group/github-task-row grid min-h-12 cursor-pointer gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        githubTaskGridClass
      )}
    >
      <div className={GITHUB_TASK_STICKY_ID_CELL_CLASS}>
        {isTaskPageGitHubDraftPR(item) ? (
          <Tooltip>
            <TooltipTrigger asChild>{githubTaskIdPill}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.054bf695cc', 'Draft')}
            </TooltipContent>
          </Tooltip>
        ) : (
          githubTaskIdPill
        )}
      </div>

      <div className={GITHUB_TASK_STICKY_TITLE_CELL_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-medium text-foreground">{item.title}</h3>
          {item.type === 'pr' && item.state !== 'open' && item.state !== 'draft' ? (
            <TaskPageGitHubWorkItemStateBadge item={item} className="shrink-0 px-1.5 py-0" />
          ) : null}
          {selectedRepoCount > 1 && itemRepo ? (
            // Why: disambiguate rows in the merged multi-repo list; a single-repo view doesn't need it.
            <RepoBadgeLabel
              name={itemRepo.displayName}
              color={itemRepo.badgeColor}
              badgeClassName="size-1.5"
              className="shrink-0 text-[11px] text-muted-foreground"
            />
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-muted-foreground">
          <span>
            {item.author ?? translate('auto.components.TaskPage.6430594b18', 'unknown author')}
          </span>
          {selectedRepoCount === 1 && itemRepo ? <span>{itemRepo.displayName}</span> : null}
          {item.type === 'pr' && item.state === 'draft' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{translate('auto.components.TaskPage.054bf695cc', 'Draft')}</span>
            </>
          ) : null}
          {prDelta ? (
            <span className="inline-flex items-center gap-1">
              <Files className="size-3" />
              {prDelta}
            </span>
          ) : null}
          {attachedWorkspaceLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <FolderKanban className="size-3 shrink-0" />
              <span className="truncate">{attachedWorkspaceLabel}</span>
            </span>
          ) : null}
          {item.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="rounded-full border border-border/40 bg-muted/30 px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {!showPRManagementColumns ? (
        <div className="min-w-0 flex items-center text-xs text-muted-foreground">
          <GHAssigneesCell
            item={item}
            repo={itemRepo ?? null}
            sourceContext={rowSourceContext}
            workItemMutation={githubWorkItemMutation}
          />
        </div>
      ) : null}

      {showPRManagementColumns ? (
        <>
          <div className="flex min-w-0 items-center">
            <PRReviewCell
              item={item}
              repo={itemRepo ?? null}
              sourceContext={rowSourceContext}
              workItemMutation={githubWorkItemMutation}
            />
          </div>

          <div className="flex min-w-0 items-center">
            <PRChecksCell
              item={item}
              onOpen={() => openGitHubDetailPage(item, 'checks')}
              onLoadChecks={() => ensurePRChecksLoaded(item)}
            />
          </div>

          <div className="flex min-w-0 items-center">
            <PRMergeCell
              item={item}
              repo={itemRepo ?? null}
              sourceContext={rowSourceContext}
              workItemMutation={githubWorkItemMutation}
            />
          </div>
        </>
      ) : (
        <div className="flex items-center">
          <GHStatusCell
            item={item}
            repo={itemRepo ?? null}
            sourceContext={rowSourceContext}
            workItemMutation={githubWorkItemMutation}
          />
        </div>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center text-[11px] text-muted-foreground">
            {formatRelativeTime(item.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(item.updatedAt).toLocaleString(getIntlLocale())}
        </TooltipContent>
      </Tooltip>

      <GithubWorkItemRowActions
        item={item}
        attachedWorkspace={attachedWorkspace}
        handleOpenOrUseGitHubWorkItem={handleOpenOrUseGitHubWorkItem}
        handleUseWorkItem={handleUseWorkItem}
      />
    </div>
  )
}
