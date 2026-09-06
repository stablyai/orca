import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { LoaderCircle } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TaskPageJiraSortControls } from '../../task-page-jira-sort-controls'
import { TaskPageJiraErrorBanner } from '../../task-page-linear-jira-list-model'
import { TaskPageJiraIssueList } from '@/components/task-page-jira-issue-list'
import { formatRelativeTime } from '../../task-page-source-context'
import { getJiraStatusTone } from '@/components/task-page-jira-status-tone'
import JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import { TaskPageLinearContent } from '../linear/Content'
export function TaskPageJiraContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    jiraStatus,
    jiraStatusReady,
    jiraConnected,
    selectedJiraSiteId,
    hideTaskSource,
    taskSource,
    closeTaskDetailPage,
    selectedJiraIssue,
    jiraDetailSourceContext,
    openJiraDetailPage,
    jiraIssues,
    jiraLoading,
    jiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraSearchInput,
    jiraOrderBy,
    jiraOrderDirection,
    handleJiraSort,
    displayedJiraIssues,
    displayedJiraStatusOrder,
    sortedJiraIssues,
    setJiraConnectOpen,
    handleUseJiraItem
  } = model
  return taskSource === 'jira' ? (
    !jiraStatusReady ? (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : !jiraConnected ? (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <JiraIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('auto.components.TaskPage.a150c59da7', 'Connect your Jira site')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.TaskPage.b518ae6307',
            'Browse, edit, create, and start work from Jira issues directly from here.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setJiraConnectOpen(true)}>
            {translate('auto.components.TaskPage.83bce6be5c', 'Connect Jira')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('jira', 'Jira')}>
            {translate('auto.components.TaskPage.e7115334aa', 'Hide Jira')}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
          <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {translate('auto.components.TaskPage.63b2abd3aa', 'Jira issues')}
          </div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {displayedJiraIssues.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
          </div>
        </div>

        <TaskPageJiraSortControls
          direction={jiraOrderDirection}
          onSort={handleJiraSort}
          orderBy={jiraOrderBy}
        />

        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
          style={{
            scrollbarGutter: 'stable'
          }}
        >
          {jiraStatus.credentialError ? (
            <div className="border-b border-border px-4 py-4 text-sm text-destructive">
              {jiraStatus.credentialError}
            </div>
          ) : null}
          {!jiraStatus.credentialError && jiraError ? (
            <TaskPageJiraErrorBanner
              error={jiraError}
              open={jiraErrorDetailsOpen}
              onOpenChange={setJiraErrorDetailsOpen}
            />
          ) : null}

          {jiraLoading && jiraIssues.length === 0 ? (
            <div className="divide-y divide-border/50">
              {Array.from({
                length: 6
              }).map((_, i) => (
                <div key={i} className="px-3 py-3">
                  <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                  <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                </div>
              ))}
            </div>
          ) : null}

          {!jiraLoading && jiraIssues.length === 0 && !jiraError && !jiraStatus.credentialError ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.TaskPage.eba87f2edb', 'No Jira issues found')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {jiraSearchInput
                  ? translate('auto.components.TaskPage.f51e254d35', 'Try a different JQL query.')
                  : translate(
                      'auto.components.TaskPage.94d900518d',
                      'No issues match the selected preset.'
                    )}
              </p>
            </div>
          ) : null}

          <TaskPageJiraIssueList
            formatUpdatedAt={formatRelativeTime}
            getStatusTone={getJiraStatusTone}
            issues={sortedJiraIssues}
            onOpenIssue={openJiraDetailPage}
            onStartWorkspace={handleUseJiraItem}
            selectedIssue={selectedJiraIssue}
            showSiteContext={selectedJiraSiteId === 'all'}
            statusDirection={jiraOrderBy === 'status' ? jiraOrderDirection : 'asc'}
            statusOrder={displayedJiraStatusOrder}
          />
        </div>
        <JiraIssueWorkspace
          issue={selectedJiraIssue}
          onUse={handleUseJiraItem}
          onClose={closeTaskDetailPage}
          sourceContext={jiraDetailSourceContext}
        />
      </div>
    )
  ) : (
    <TaskPageLinearContent model={model} />
  )
}
