import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { findGithubWorkItemWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { formatPRDelta } from '@/components/task-page-pr-delta-summary'
import {
  isTaskPageGitHubDraftPR,
  getTaskPageGitHubPRIconTone
} from '@/components/task-page-github-work-item-status'
import {
  GitPullRequestDraft,
  GitPullRequest,
  CircleDot,
  Files,
  FolderKanban,
  ArrowRight,
  ChevronDown,
  Plus,
  ExternalLink,
  EllipsisVertical
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  GITHUB_TASK_STICKY_ID_CELL_CLASS,
  GITHUB_TASK_STICKY_TITLE_CELL_CLASS,
  getTaskPageRepoSourceContext,
  formatRelativeTime
} from '../../task-page-source-context'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { TaskPageGitHubWorkItemStateBadge } from '@/components/task-page-github-work-item-status-badge'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { GHAssigneesCell } from './AssigneesCell'
import { PRReviewCell } from './ReviewCell'
import { PRChecksCell } from './ChecksCell'
import { PRMergeCell } from './MergeCell'
import { GHStatusCell } from './StatusCell'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { ButtonGroup } from '@/components/ui/button-group'
import { Button } from '@/components/ui/button'
export function TaskPageGitHubRows({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    repoMap,
    allWorktrees,
    selectedRepos,
    openGitHubDetailPage,
    githubWorkItemMutation,
    filteredWorkItems,
    showGitHubTaskSkeletons,
    showPRManagementColumns,
    githubTaskGridClass,
    ensurePRChecksLoaded,
    handleUseWorkItem,
    handleOpenOrUseGitHubWorkItem
  } = model
  return (
    <div className="divide-y divide-border/40">
      {!showGitHubTaskSkeletons &&
        filteredWorkItems.map((item) => {
          const itemRepo = repoMap.get(item.repoId) ?? null
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
          const githubTaskIdPill = (
            <span
              // Why: no fill — a muted wash on the pill stacks on the
              // row's hover:bg-accent and reads as a second hover tint.
              className="inline-flex items-center gap-1 rounded-md border border-border/40 px-1.5 py-0.5 text-muted-foreground"
              aria-label={`${item.type === 'pr' ? (isTaskPageGitHubDraftPR(item) ? 'Draft pull request' : 'Pull request') : 'Issue'} #${item.number}`}
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
              key={`${item.repoId}:${item.id}`}
              role="button"
              tabIndex={0}
              onClick={() => openGitHubDetailPage(item)}
              onKeyDown={(event) => {
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
                    <TaskPageGitHubWorkItemStateBadge
                      item={item}
                      className="shrink-0 px-1.5 py-0"
                    />
                  ) : null}
                  {selectedRepos.length > 1 && itemRepo ? (
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
                    {item.author ??
                      translate('auto.components.TaskPage.6430594b18', 'unknown author')}
                  </span>
                  {selectedRepos.length === 1 && itemRepo ? (
                    <span>{itemRepo.displayName}</span>
                  ) : null}
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
                    sourceContext={getTaskPageRepoSourceContext(itemRepo, 'github')}
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
                      sourceContext={getTaskPageRepoSourceContext(itemRepo, 'github')}
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
                      sourceContext={getTaskPageRepoSourceContext(itemRepo, 'github')}
                      workItemMutation={githubWorkItemMutation}
                    />
                  </div>
                </>
              ) : (
                <div className="flex items-center">
                  <GHStatusCell
                    item={item}
                    repo={itemRepo ?? null}
                    sourceContext={getTaskPageRepoSourceContext(itemRepo, 'github')}
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
                  {new Date(item.updatedAt).toLocaleString()}
                </TooltipContent>
              </Tooltip>

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
                            : translate(
                                'auto.components.TaskPage.e4b29c5bcf',
                                'Start workspace from PR'
                              )
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
                          aria-label={translate(
                            'auto.components.TaskPage.7deb9e59a5',
                            'More PR actions'
                          )}
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
                        ? translate(
                            'auto.components.TaskPage.2193a99ec1',
                            'Open workspace attached to issue'
                          )
                        : translate(
                            'auto.components.TaskPage.e104fa3d3d',
                            'Start workspace from issue'
                          )
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
                        aria-label={translate(
                          'auto.components.TaskPage.66ae7330f6',
                          'More actions'
                        )}
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
            </div>
          )
        })}
    </div>
  )
}
