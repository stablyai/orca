import { LoaderCircle, RefreshCw } from 'lucide-react'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { ClickUpTaskList } from './listing/clickup-task-list'
import ClickUpTaskWorkspace from './task-workspace/ClickUpTaskWorkspace'

export function TaskPageClickUpContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const {
    clickupStatus,
    clickupStatusReady,
    clickupConnected,
    clickupConnectionLost,
    clickupRuntimeUpdateRequired,
    setClickUpConnectOpen,
    hideTaskSource,
    clickupTasks,
    clickupLoading,
    clickupLoadingMore,
    clickupError,
    clickupNextPage,
    loadMoreClickUpTasks,
    refreshClickUpTasks,
    appliedClickUpSearch,
    clickupFilter,
    selectedClickUpTask,
    clickupDetailSourceContext,
    openClickUpDetailPage,
    handleUseClickUpItem,
    handleUseClickUpDetailItem,
    closeTaskDetailPage
  } = model

  if (!clickupStatusReady) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (clickupRuntimeUpdateRequired) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <ClickUpIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {t('taskProviders.clickup.runtimeUpdateTitle', 'ClickUp needs a newer remote runtime')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {t(
            'taskProviders.clickup.runtimeUpdateBody',
            'Update the remote runtime to connect ClickUp.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" onClick={() => hideTaskSource('clickup', 'ClickUp')}>
            {t('taskProviders.clickup.hide', 'Hide ClickUp')}
          </Button>
        </div>
      </div>
    )
  }
  if (!clickupConnected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <ClickUpIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {clickupConnectionLost
            ? t('taskProviders.clickup.reconnectPromptTitle', 'ClickUp needs a new token')
            : t('taskProviders.clickup.connectPromptTitle', 'Connect your ClickUp account')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {clickupConnectionLost
            ? t(
                'taskProviders.clickup.reconnectPromptBody',
                'ClickUp rejected the saved token. It may have been revoked or regenerated. Add a new personal API token to keep browsing tasks.'
              )
            : t(
                'taskProviders.clickup.connectPromptBody',
                'Browse, comment on, and start work from ClickUp tasks directly from here.'
              )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setClickUpConnectOpen(true)}>
            {clickupConnectionLost
              ? t('taskProviders.clickup.reconnectAction', 'Reconnect ClickUp')
              : t('taskProviders.clickup.connectAction', 'Connect ClickUp')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('clickup', 'ClickUp')}>
            {t('taskProviders.clickup.hide', 'Hide ClickUp')}
          </Button>
        </div>
      </div>
    )
  }

  // Why: a page can come back empty once closed tasks are dropped while later pages still hold open ones.
  const showEmpty =
    !clickupLoading && clickupTasks.length === 0 && !clickupError && clickupNextPage === null
  return (
    <div className="@container flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex min-h-10 flex-none flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3 py-1">
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t('taskProviders.clickup.listTitle', 'ClickUp tasks')}
        </div>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {t('auto.components.TaskPage.shownCount', '{{count}} shown', {
            count: clickupTasks.length,
            defaultValue_one: '{{count}} shown'
          })}
        </span>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {clickupStatus.credentialError ? (
          <div role="alert" className="border-b border-border px-4 py-4 text-sm text-destructive">
            {clickupStatus.credentialError}
          </div>
        ) : null}
        {!clickupStatus.credentialError && clickupError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm text-destructive"
          >
            <span className="min-w-0 break-words">{clickupError}</span>
            <Button
              variant="outline"
              size="xs"
              onClick={refreshClickUpTasks}
              disabled={clickupLoading}
              className="shrink-0"
            >
              <RefreshCw className="size-3" />
              {t('taskProviders.clickup.retry', 'Retry')}
            </Button>
          </div>
        ) : null}

        {clickupLoading && clickupTasks.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}

        {showEmpty && !clickupStatus.credentialError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {appliedClickUpSearch
                ? t(
                    'taskProviders.clickup.emptySearchTitle',
                    'No recently updated ClickUp tasks match this search'
                  )
                : clickupFilter.scope === 'assigned'
                  ? t(
                      'taskProviders.clickup.emptyAssignedTitle',
                      'No ClickUp tasks assigned to you'
                    )
                  : t('taskProviders.clickup.emptyTitle', 'No ClickUp tasks found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {appliedClickUpSearch
                ? t(
                    'taskProviders.clickup.emptySearchBody',
                    'Search checks the names and custom IDs of recently updated tasks only. Paste a task ID or link to find any task.'
                  )
                : clickupFilter.scope === 'assigned'
                  ? t(
                      'taskProviders.clickup.emptyAssignedBody',
                      'Switch to All to see every task in this Workspace, or include closed tasks.'
                    )
                  : t(
                      'taskProviders.clickup.emptyBody',
                      'Nothing matches the selected filters in this Workspace.'
                    )}
            </p>
          </div>
        ) : null}

        <ClickUpTaskList
          tasks={clickupTasks}
          selectedTaskId={selectedClickUpTask?.id ?? null}
          onOpenTask={openClickUpDetailPage}
          onStartWorkspace={handleUseClickUpItem}
        />

        {clickupNextPage !== null ? (
          <div className="flex justify-center border-t border-border/50 px-3 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadMoreClickUpTasks()}
              disabled={clickupLoadingMore}
            >
              {clickupLoadingMore ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {t('taskProviders.clickup.loadMore', 'Load more')}
            </Button>
          </div>
        ) : null}
      </div>
      <ClickUpTaskWorkspace
        task={selectedClickUpTask}
        sourceContext={clickupDetailSourceContext}
        onUse={handleUseClickUpDetailItem}
        onClose={closeTaskDetailPage}
      />
    </div>
  )
}
