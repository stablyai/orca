import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { LoaderCircle } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { jiraListGridStyle } from '../../jira-list-columns'
import { JiraListColumnsMenu } from '../../jira-list-columns-menu'
import { TaskPageJiraSortControls } from '../../task-page-jira-sort-controls'
import { TaskPageJiraErrorBanner } from '../linear/task-page-linear-jira-list-model'
import { TaskPageJiraTextFallbackNotice } from './task-page-jira-text-fallback-notice'
import { TaskPageJiraIssueList } from '@/components/task-page-jira-issue-list'
import { TaskPageJiraBoardView } from '@/components/task-page-jira-board-view'
import { TaskPageJiraViewControls } from '@/components/task-page-jira-view-controls'
import { formatRelativeTime } from '../task-page-source-context'
import { getJiraStatusTone } from '@/components/task-page/jira/task-page-jira-status-tone'
import JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import { TaskPageLinearContent } from '../linear/Content'
import {
  ipcOrRuntimeTargetForHostId,
  runtimeTargetEnvironmentId
} from '@/runtime/runtime-client-target'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
export function TaskPageJiraContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    jiraStatus,
    jiraHasWorkspace,
    getJiraIssueWorkspaces,
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
    jiraJqlRejection,
    jiraSearchInput,
    jiraOrderBy,
    jiraOrderDirection,
    handleJiraSort,
    jiraColumnIds,
    jiraColumns,
    toggleJiraColumn,
    displayedJiraIssues,
    displayedJiraStatusOrder,
    sortedJiraIssues,
    setJiraConnectOpen,
    handleUseJiraItem,
    jiraViewMode,
    setJiraViewMode,
    jiraCurrentSprint,
    setJiraCurrentSprint,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    accountBackedTaskSourceHostId,
    setJiraRefreshNonce
  } = model
  const boardTarget = ipcOrRuntimeTargetForHostId(
    jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId
  )
  const boardScopeKey = JSON.stringify([
    jiraTaskSourceScopeKey,
    boardTarget ? getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(boardTarget)) : null
  ])
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
      <div
        style={jiraListGridStyle(jiraColumns)}
        className="@container flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm"
      >
        <div className="flex min-h-10 flex-none flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3 py-1">
          <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {translate('auto.components.TaskPage.63b2abd3aa', 'Jira issues')}
          </div>
          <TaskPageJiraViewControls
            mode={jiraViewMode}
            onModeChange={setJiraViewMode}
            currentSprint={jiraCurrentSprint}
            onCurrentSprintChange={setJiraCurrentSprint}
            sprintDisabled={jiraHasWorkspace}
          />
          <div className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
            <span>
              {translate('auto.components.TaskPage.shownCount', '{{count}} shown', {
                count: displayedJiraIssues.length,
                defaultValue_one: '{{count}} shown'
              })}
            </span>
            {jiraViewMode === 'list' ? (
              <JiraListColumnsMenu ids={jiraColumnIds} onToggle={toggleJiraColumn} />
            ) : null}
          </div>
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto scrollbar-sleek"
          style={{
            scrollbarGutter: 'stable'
          }}
        >
          {jiraViewMode === 'list' ? (
            <TaskPageJiraSortControls
              columns={jiraColumns}
              direction={jiraOrderDirection}
              onSort={handleJiraSort}
              orderBy={jiraOrderBy}
            />
          ) : null}

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
          <TaskPageJiraTextFallbackNotice
            rejection={jiraStatus.credentialError ? null : jiraJqlRejection}
          />

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

          {!jiraLoading &&
          displayedJiraIssues.length === 0 &&
          !jiraError &&
          !jiraStatus.credentialError ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.TaskPage.eba87f2edb', 'No Jira issues found')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {jiraHasWorkspace
                  ? translate(
                      'jira.workspace.empty',
                      'Link a Jira issue to a workspace, or choose another view.'
                    )
                  : jiraSearchInput
                    ? translate(
                        'auto.components.TaskPage.f51e254d35',
                        'Try different search terms or JQL.'
                      )
                    : translate(
                        'auto.components.TaskPage.94d900518d',
                        'No issues match the selected preset.'
                      )}
              </p>
            </div>
          ) : null}

          {jiraViewMode === 'board' ? (
            <TaskPageJiraBoardView
              key={`${boardScopeKey}:${selectedJiraSiteId}`}
              issues={sortedJiraIssues}
              statusOrder={displayedJiraStatusOrder}
              selectedIssue={selectedJiraIssue}
              sourceContext={jiraTaskSourceContext}
              target={boardTarget}
              scopeKey={boardScopeKey}
              onOpenIssue={openJiraDetailPage}
              onStartWorkspace={handleUseJiraItem}
              showSiteContext={selectedJiraSiteId === 'all'}
              loading={jiraLoading}
              onRefresh={() => setJiraRefreshNonce((value) => value + 1)}
            />
          ) : (
            <TaskPageJiraIssueList
              getIssueWorkspaces={getJiraIssueWorkspaces}
              onOpenWorkspace={(workspace) => {
                if (
                  activateAndRevealWorktree(workspace.id, { navigationIntent: 'user-open' }) ===
                  false
                ) {
                  toast.error(
                    translate(
                      'jira.workspace.openFailed',
                      'Unable to open the workspace linked to this Jira issue.'
                    )
                  )
                }
              }}
              columns={jiraColumns}
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
          )}
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
