import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { MantisBTIcon } from '@/components/icons/MantisBTIcon'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TaskPageMantisBTSortControls } from '../../task-page-mantisbt-sort-controls'
import { TaskPageJiraErrorBanner } from '../../task-page-linear-jira-list-model'
import { TaskPageMantisBTIssueList } from '@/components/task-page-mantisbt-issue-list'
import { formatRelativeTime } from '../../task-page-source-context'
import MantisBTIssueWorkspace from '@/components/MantisBTIssueWorkspace'

// Why: MantisBT has no server-side handler_id/reporter_id filter, so a large
// self-hosted instance can take much longer than a typical fetch (see
// ISSUE_SEARCH_TIMEOUT_MS in src/main/mantisbt/mantisbt-issue-search.ts) —
// reassure rather than let a bare spinner look frozen past a few seconds.
function useMantisBTSlowLoadHint(loading: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 4000)
    return () => window.clearTimeout(timer)
  }, [loading])
  return slow
}

export function TaskPageMantisBTContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    mantisBTStatus,
    mantisBTStatusReady,
    mantisBTConnected,
    selectedMantisBTSiteId,
    hideTaskSource,
    taskSource,
    closeTaskDetailPage,
    selectedMantisBTIssue,
    mantisBTDetailSourceContext,
    openMantisBTDetailPage,
    mantisBTLoading,
    mantisBTError,
    mantisBTErrorDetailsOpen,
    setMantisBTErrorDetailsOpen,
    mantisBTSearchInput,
    mantisBTOrderBy,
    mantisBTOrderDirection,
    handleMantisBTSort,
    displayedMantisBTIssues,
    sortedMantisBTIssues,
    setMantisBTConnectOpen,
    handleUseMantisBTItem
  } = model
  const showSlowLoadHint = useMantisBTSlowLoadHint(mantisBTLoading)
  return taskSource === 'mantisBT' ? (
    !mantisBTStatusReady ? (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : !mantisBTConnected ? (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <MantisBTIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('auto.components.TaskPage.mantisbtConnectTitle', 'Connect your MantisBT site')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.TaskPage.mantisbtConnectBody',
            'Browse issues and start work from them directly here.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setMantisBTConnectOpen(true)}>
            {translate('auto.components.TaskPage.mantisbtConnectCta', 'Connect MantisBT')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('mantisBT', 'MantisBT')}>
            {translate('auto.components.TaskPage.mantisbtHideSource', 'Hide MantisBT')}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
          <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {translate('auto.components.TaskPage.mantisbtIssuesHeader', 'MantisBT issues')}
          </div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {displayedMantisBTIssues.length}{' '}
            {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
          </div>
        </div>

        <TaskPageMantisBTSortControls
          direction={mantisBTOrderDirection}
          onSort={handleMantisBTSort}
          orderBy={mantisBTOrderBy}
        />

        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
          style={{
            scrollbarGutter: 'stable'
          }}
        >
          {mantisBTStatus.credentialError ? (
            <div className="border-b border-border px-4 py-4 text-sm text-destructive">
              {mantisBTStatus.credentialError}
            </div>
          ) : null}
          {!mantisBTStatus.credentialError && mantisBTError ? (
            <TaskPageJiraErrorBanner
              error={mantisBTError}
              open={mantisBTErrorDetailsOpen}
              onOpenChange={setMantisBTErrorDetailsOpen}
            />
          ) : null}

          {mantisBTLoading && displayedMantisBTIssues.length === 0 ? (
            <div className="divide-y divide-border/50">
              {Array.from({
                length: 6
              }).map((_, i) => (
                <div key={i} className="px-3 py-3">
                  <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                  <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                </div>
              ))}
              {showSlowLoadHint ? (
                <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {translate(
                    'auto.components.TaskPage.mantisbtSlowLoadHint',
                    'Still loading — this can take longer for MantisBT instances with many issues.'
                  )}
                </p>
              ) : null}
            </div>
          ) : null}

          {!mantisBTLoading &&
          displayedMantisBTIssues.length === 0 &&
          !mantisBTError &&
          !mantisBTStatus.credentialError ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.TaskPage.mantisbtNoIssues', 'No MantisBT issues found')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {mantisBTSearchInput
                  ? translate(
                      'auto.components.TaskPage.mantisbtNoIssuesSearch',
                      'Try a different filter.'
                    )
                  : translate(
                      'auto.components.TaskPage.94d900518d',
                      'No issues match the selected preset.'
                    )}
              </p>
            </div>
          ) : null}

          <TaskPageMantisBTIssueList
            formatUpdatedAt={formatRelativeTime}
            issues={sortedMantisBTIssues}
            onOpenIssue={openMantisBTDetailPage}
            onStartWorkspace={handleUseMantisBTItem}
            selectedIssue={selectedMantisBTIssue}
            showSiteContext={selectedMantisBTSiteId === 'all'}
            statusDirection={mantisBTOrderBy === 'status' ? mantisBTOrderDirection : 'asc'}
          />
        </div>
        <MantisBTIssueWorkspace
          issue={selectedMantisBTIssue}
          onUse={handleUseMantisBTItem}
          onClose={closeTaskDetailPage}
          sourceContext={mantisBTDetailSourceContext}
        />
      </div>
    )
  ) : null
}
