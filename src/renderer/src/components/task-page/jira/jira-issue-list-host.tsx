import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { JiraIcon } from '@/components/icons/JiraIcon'
import JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import { TaskPageJiraIssueList } from '@/components/task-page-jira-issue-list'
import { TaskPageJiraSortControls } from '@/components/task-page-jira-sort-controls'
import { getJiraStatusTone } from '@/components/task-page-jira-status-tone'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import { translate } from '@/i18n/i18n'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../../../shared/jira-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { JiraIssueSortColumn, JiraIssueSortDirection } from '@/components/jira-issue-sorter'
import { TaskPageJiraErrorBanner } from './jira-error-banner'
import { formatRelativeTime } from '../relative-time'

export type JiraIssueListHostProps = {
  jiraStatusReady: boolean
  jiraConnected: boolean
  setJiraConnectOpen: (open: boolean) => void
  hideTaskSource: (provider: TaskProvider, label: string) => void
  displayedJiraIssues: readonly JiraIssue[]
  jiraOrderDirection: JiraIssueSortDirection
  handleJiraSort: (column: JiraIssueSortColumn) => void
  jiraOrderBy: JiraIssueSortColumn
  jiraStatusCredentialError: string | null | undefined
  jiraError: TaskPageJiraLoadError | null
  jiraErrorDetailsOpen: boolean
  setJiraErrorDetailsOpen: (open: boolean) => void
  jiraLoading: boolean
  jiraIssues: readonly JiraIssue[]
  jiraSearchInput: string
  sortedJiraIssues: JiraIssue[]
  openJiraDetailPage: (issue: JiraIssue) => void
  handleUseJiraItem: (issue: JiraIssue) => void
  selectedJiraIssue: JiraIssue | null
  selectedJiraSiteId: string | null
  displayedJiraStatusOrder: JiraProjectStatusOrder | null
  closeTaskDetailPage: () => void
  jiraDetailSourceContext: TaskSourceContext | null
}

export function JiraIssueListHost({
  jiraStatusReady,
  jiraConnected,
  setJiraConnectOpen,
  hideTaskSource,
  displayedJiraIssues,
  jiraOrderDirection,
  handleJiraSort,
  jiraOrderBy,
  jiraStatusCredentialError,
  jiraError,
  jiraErrorDetailsOpen,
  setJiraErrorDetailsOpen,
  jiraLoading,
  jiraIssues,
  jiraSearchInput,
  sortedJiraIssues,
  openJiraDetailPage,
  handleUseJiraItem,
  selectedJiraIssue,
  selectedJiraSiteId,
  displayedJiraStatusOrder,
  closeTaskDetailPage,
  jiraDetailSourceContext
}: JiraIssueListHostProps): React.JSX.Element {
  if (!jiraStatusReady) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!jiraConnected) {
    return (
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
    )
  }

  return (
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
        style={{ scrollbarGutter: 'stable' }}
      >
        {jiraStatusCredentialError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {jiraStatusCredentialError}
          </div>
        ) : null}
        {!jiraStatusCredentialError && jiraError ? (
          <TaskPageJiraErrorBanner
            error={jiraError}
            open={jiraErrorDetailsOpen}
            onOpenChange={setJiraErrorDetailsOpen}
          />
        ) : null}

        {jiraLoading && jiraIssues.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}

        {!jiraLoading && jiraIssues.length === 0 && !jiraError && !jiraStatusCredentialError ? (
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
}
