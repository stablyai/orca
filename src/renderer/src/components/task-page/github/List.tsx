import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  GITHUB_TASK_HEADER_SURFACE_CLASS,
  GITHUB_TASK_STICKY_ID_HEADER_CLASS,
  GITHUB_TASK_STICKY_TITLE_HEADER_CLASS,
  GITHUB_TASK_STICKY_ID_CELL_CLASS,
  GITHUB_TASK_STICKY_TITLE_CELL_CLASS
} from '../../task-page-source-context'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { LoaderCircle } from 'lucide-react'
import { TaskPageGitHubRows } from './Rows'
import { PaginationBar } from '../PaginationBar'
import { supersedeGitHubListScrollRestore } from '../../task-page-github-list-scroll-restore'
export function TaskPageGitHubList({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    selectedRepos,
    githubEmptyState,
    tasksLoading,
    tasksError,
    failedCount,
    githubUnavailable,
    githubResumeContextKey,
    pages,
    currentPage,
    setCurrentPage,
    currentPageRef,
    githubListScrollRef,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef,
    githubListRestoreWriteRef,
    loadingTargetPage,
    taskListPositionRef,
    perRepoSourceState,
    unresolvedSourceRepos,
    retryingSourceKeys,
    handleRetryIssuesFetch,
    activeGithubTaskKind,
    filteredWorkItems,
    softHiddenVisibleCount,
    showGitHubTaskSkeletons,
    showPRManagementColumns,
    githubTaskGridClass,
    totalPages,
    handleLoadNextPage
  } = model
  return (
    // Why: bottom of the joined GitHub list card — flush under the filter
    // chrome (no gap, no top border/radius) so toolbar + table read as one.
    <div className="flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div
        ref={githubListScrollRef}
        data-task-list-scroll="github"
        className="min-h-0 flex-initial overflow-auto scrollbar-sleek scrollbar-sleek-lg"
        style={{
          scrollbarGutter: 'stable'
        }}
        onScroll={(event) => {
          const state = useAppStore.getState()
          if (state.activeView !== 'tasks' || state.taskPageData.openGitHubWorkItem) {
            return
          }
          const scrollTop = event.currentTarget.scrollTop
          // Why: a restore's own write must not be saved as the user's position, but a real
          // user scroll has to supersede a pending restore or saving stays suppressed.
          if (
            !supersedeGitHubListScrollRestore({
              scrollTop,
              pendingRestoreRef: pendingGithubScrollRestoreRef,
              restoreWriteRef: githubListRestoreWriteRef
            })
          ) {
            return
          }
          githubListScrollTopRef.current = scrollTop
          taskListPositionRef.current = {
            contextKey: githubResumeContextKey,
            page: currentPageRef.current,
            scrollTop
          }
        }}
      >
        <div
          // Why: z-40 must beat the rows' sticky left cells (z-20); this stacking context's z sets the whole header's level.
          className={cn(
            'sticky top-0 z-40 grid h-8 gap-3 border-b border-border/50 px-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground [&>span]:flex [&>span]:items-center',
            GITHUB_TASK_HEADER_SURFACE_CLASS,
            githubTaskGridClass
          )}
        >
          <span className={GITHUB_TASK_STICKY_ID_HEADER_CLASS}>
            {translate('auto.components.TaskPage.eb10c32872', 'ID')}
          </span>
          <span className={GITHUB_TASK_STICKY_TITLE_HEADER_CLASS}>
            {translate('auto.components.TaskPage.5eccb3c841', 'Title / Context')}
          </span>
          {activeGithubTaskKind === 'issues' ? (
            <span>{translate('auto.components.TaskPage.8aba10579d', 'Assignees')}</span>
          ) : null}
          {showPRManagementColumns ? (
            <>
              <span>{translate('auto.components.TaskPage.f6fa3c97d0', 'Reviewers')}</span>
              <span>{translate('auto.components.TaskPage.a7396b05c6', 'Checks')}</span>
              <span>{translate('auto.components.TaskPage.443f7dd928', 'Merge')}</span>
            </>
          ) : (
            <span>{translate('auto.components.TaskPage.154b0fa623', 'Status')}</span>
          )}
          <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
          <span />
        </div>

        {tasksError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {tasksError}
          </div>
        ) : null}

        {!tasksError && githubUnavailable ? (
          // Why: name the GitHub outage explicitly so an empty list isn't misread as an Orca bug; takes priority over the count banner.
          <div
            role="alert"
            className="border-b border-border/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {translate(
              'auto.components.TaskPage.75a38d7df8',
              'GitHub data is temporarily unavailable. Its API may be down, rate-limited, or unreachable. Please try again shortly.'
            )}
          </div>
        ) : null}

        {!tasksError && !githubUnavailable && failedCount > 0 ? (
          // Why: per-repo partial-failure signal, distinct from a hard IPC reject (tasksError); the two are mutually exclusive.
          <div className="border-b border-border/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
            {failedCount} {translate('auto.components.TaskPage.7762f4b03a', 'of')}{' '}
            {selectedRepos.length}{' '}
            {translate('auto.components.TaskPage.d1766fd62d', 'projects failed to load')}
          </div>
        ) : null}

        {perRepoSourceState
          .filter((s) => s.error)
          .map((s) => {
            const err = s.error!
            // Why: Retry re-fetches force=true via the shared refresh nonce, invalidating any still-failing in-flight request first.
            return (
              <div
                key={`source-err-${s.repoId}`}
                role="alert"
                // Why: aria-atomic re-announces the whole banner on a new same-repo error SRs would otherwise miss (stable key → text-only diff).
                aria-atomic="true"
                className="flex items-center justify-between gap-3 border-b border-border/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                <span>
                  {translate('auto.components.TaskPage.0c0de0fc0e', "Couldn't load issues from")}{' '}
                  <span className="font-mono">
                    {err.source.owner}/{err.source.repo}
                  </span>{' '}
                  — {err.message}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRetryIssuesFetch(s.sourceKey)}
                  disabled={tasksLoading || retryingSourceKeys.has(s.sourceKey)}
                >
                  {retryingSourceKeys.has(s.sourceKey) ? (
                    <span className="flex items-center gap-1">
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                      {translate('auto.components.TaskPage.5b6b2af943', 'Retrying…')}
                    </span>
                  ) : (
                    translate('auto.components.TaskPage.0bfbf62f75', 'Retry')
                  )}
                </Button>
              </div>
            )
          })}

        {unresolvedSourceRepos.map((r) => (
          // Why: null-source repos (#9660) render empty like genuine zero — name the repo and offer Retry so a transient resolve blip is recoverable.
          <div
            key={`source-unresolved-${r.repoId}`}
            role="status"
            aria-atomic="true"
            className="flex items-center justify-between gap-3 border-b border-border/50 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            <span>
              {translate(
                'auto.components.TaskPage.noGithubSourceDetected',
                'No GitHub source detected for'
              )}{' '}
              <span className="font-mono">{r.label}</span> —{' '}
              {translate(
                'auto.components.TaskPage.noGithubSourceDetectedHint',
                'it may have no GitHub remote, or the source could not be resolved.'
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRetryIssuesFetch(r.sourceKey)}
              disabled={tasksLoading || retryingSourceKeys.has(r.sourceKey)}
            >
              {retryingSourceKeys.has(r.sourceKey) ? (
                <span className="flex items-center gap-1">
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                  {translate('auto.components.TaskPage.5b6b2af943', 'Retrying…')}
                </span>
              ) : (
                translate('auto.components.TaskPage.0bfbf62f75', 'Retry')
              )}
            </Button>
          </div>
        ))}

        {showGitHubTaskSkeletons ? (
          // Why: render enough shimmer rows to fill a typical viewport
          // so the table doesn't visibly grow when results land. A
          // 3-row stub jumps to ~30 real rows; matching the steady-
          // state height keeps layout stable across the load.
          <div className="divide-y divide-border/40">
            {Array.from({
              length: 12
            }).map((_, i) => (
              <div key={i} className={cn('grid min-h-12 gap-3 px-3 py-2.5', githubTaskGridClass)}>
                <div className={GITHUB_TASK_STICKY_ID_CELL_CLASS}>
                  <div className="h-6 w-16 animate-pulse rounded-md bg-muted/70" />
                </div>
                <div className={GITHUB_TASK_STICKY_TITLE_CELL_CLASS}>
                  <div className="h-3.5 w-3/5 animate-pulse rounded bg-muted/70" />
                  <div className="mt-1.5 h-3 w-2/5 animate-pulse rounded bg-muted/60" />
                </div>
                {!showPRManagementColumns ? (
                  <div className="flex items-center">
                    <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                  </div>
                ) : null}
                {showPRManagementColumns ? (
                  <>
                    <div className="flex items-center">
                      <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                    </div>
                    <div className="flex items-center">
                      <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                    </div>
                    <div className="flex items-center">
                      <div className="h-5 w-20 animate-pulse rounded-full bg-muted/70" />
                    </div>
                  </>
                ) : (
                  <div className="flex items-center">
                    <div className="h-5 w-14 animate-pulse rounded-full bg-muted/70" />
                  </div>
                )}
                <div className="flex items-center">
                  <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                </div>
                <div className="flex items-center justify-start lg:justify-end">
                  <div className="h-7 w-16 animate-pulse rounded-md bg-muted/70" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Why: suppress the generic empty state when any error banner is
                    visible (IPC reject via tasksError, cross-repo partial failure
                    via failedCount, or per-repo issue-side error). Showing
                    "No matching GitHub work" next to "Couldn't load issues from X/Y"
                    is contradictory and misleads the user into thinking they
                    typed the wrong query. */}
        {/* Why: soft-hidden membership exits must not look like an empty
                    query when pager/count still implies items remain — but on a
                    single page (totalPages <= 1) there's nothing else to show, so
                    surface the empty state instead of a blank panel. */}
        {!showGitHubTaskSkeletons &&
        filteredWorkItems.length === 0 &&
        (softHiddenVisibleCount === 0 || totalPages <= 1) &&
        !tasksError &&
        !githubUnavailable &&
        failedCount === 0 &&
        unresolvedSourceRepos.length === 0 &&
        perRepoSourceState.every((s) => !s.error) ? (
          <div className="px-4 py-10 text-center">
            <p className="text-base font-medium text-foreground">{githubEmptyState.title}</p>
            <p className="mt-2 text-sm text-muted-foreground">{githubEmptyState.description}</p>
          </div>
        ) : null}

        <TaskPageGitHubRows model={model} />
      </div>

      {/* Why: pagination sits outside the scroll container so it
                  remains pinned at the bottom of the panel rather than
                  hiding below the last row inside the scrolling region. */}
      {(filteredWorkItems.length > 0 || softHiddenVisibleCount > 0) &&
      !showGitHubTaskSkeletons &&
      totalPages > 1 ? (
        <div className="flex-none border-t border-border/50 bg-background">
          <PaginationBar
            currentPage={currentPage}
            totalPages={totalPages}
            loadingTarget={loadingTargetPage}
            onPageChange={(page) => {
              pendingGithubScrollRestoreRef.current = null
              githubListScrollTopRef.current = 0
              if (githubListScrollRef.current) {
                githubListScrollRef.current.scrollTop = 0
              }
              if (pages[page] !== null && pages[page] !== undefined) {
                currentPageRef.current = page
                setCurrentPage(page)
              } else {
                void handleLoadNextPage(page)
              }
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
