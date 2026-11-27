import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { ItsaplanIcon } from '@/components/icons/ItsaplanIcon'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import ItsaplanIssueWorkspace from '@/components/ItsaplanIssueWorkspace'
import { ItsaplanIssueRow } from './listing/ItsaplanIssueRow'

export function TaskPageItsaplanContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    hideTaskSource,
    itsaplanStatusReady,
    itsaplanConnected,
    itsaplanProjects,
    itsaplanProjectRef,
    itsaplanIssues,
    itsaplanLoading,
    itsaplanError,
    itsaplanCredentialInvalid,
    appliedItsaplanSearch,
    setItsaplanConnectOpen,
    selectedItsaplanIssue,
    openItsaplanDetailPage,
    closeTaskDetailPage,
    openComposerForItsaplanItem
  } = model
  if (selectedItsaplanIssue) {
    return (
      <ItsaplanIssueWorkspace
        issue={selectedItsaplanIssue}
        backLabel={t('taskProviders.itsaplan.listLabel', "It's a Plan list")}
        onUse={openComposerForItsaplanItem}
        onOpenIssue={openItsaplanDetailPage}
        onClose={closeTaskDetailPage}
        onReconnect={() => setItsaplanConnectOpen(true)}
      />
    )
  }
  if (!itsaplanStatusReady) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!itsaplanConnected || itsaplanCredentialInvalid) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <ItsaplanIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {itsaplanCredentialInvalid
            ? t('taskProviders.itsaplan.invalidKeyTitle', 'API key invalid, reconnect')
            : t('taskProviders.itsaplan.connectTitle', "Connect It's a Plan")}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {itsaplanCredentialInvalid
            ? t(
                'taskProviders.itsaplan.invalidKeyDescription',
                "It's a Plan rejected the saved API key. Reconnect with a new key to load issues."
              )
            : t(
                'taskProviders.itsaplan.connectDescription',
                "Browse, update, create, and start work from It's a Plan issues directly from here."
              )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setItsaplanConnectOpen(true)}>
            {itsaplanCredentialInvalid
              ? t('taskProviders.itsaplan.reconnect', 'Reconnect')
              : t('taskProviders.itsaplan.connect', "Connect It's a Plan")}
          </Button>
          {itsaplanCredentialInvalid ? null : (
            <Button variant="outline" onClick={() => hideTaskSource('itsaplan', "It's a Plan")}>
              {t('taskProviders.itsaplan.hide', "Hide It's a Plan")}
            </Button>
          )}
        </div>
      </div>
    )
  }
  const noProjects = itsaplanProjects !== null && itsaplanProjects.length === 0
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex min-h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3 py-1">
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t('taskProviders.itsaplan.issuesHeading', "It's a Plan issues")}
        </div>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {t('auto.components.TaskPage.shownCount', '{{count}} shown', {
            count: itsaplanIssues.length,
            defaultValue_one: '{{count}} shown'
          })}
        </span>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {itsaplanError ? (
          <div className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-none" />
            <span className="min-w-0 break-words">{itsaplanError}</span>
          </div>
        ) : null}
        {itsaplanLoading && itsaplanIssues.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}
        {!itsaplanLoading && !itsaplanError && itsaplanIssues.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {noProjects || !itsaplanProjectRef
                ? t('taskProviders.itsaplan.noProjects', 'No projects available')
                : t('taskProviders.itsaplan.noIssues', 'No issues found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {noProjects || !itsaplanProjectRef
                ? t(
                    'taskProviders.itsaplan.noProjectsDescription',
                    'Your API key cannot read any project.'
                  )
                : appliedItsaplanSearch
                  ? t('taskProviders.itsaplan.noIssuesSearch', 'Try different search terms.')
                  : t('taskProviders.itsaplan.noIssuesFilters', 'No issues match the filters.')}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {itsaplanIssues.map((issue) => (
            <ItsaplanIssueRow
              key={issue.id}
              issue={issue}
              onOpen={openItsaplanDetailPage}
              onStart={openComposerForItsaplanItem}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
