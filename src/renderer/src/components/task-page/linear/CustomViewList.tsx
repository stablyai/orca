import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { translate } from '@/i18n/i18n'
import {
  LinearCustomViewTable,
  LinearCollectionNotice
} from '@/components/linear-project-view-surfaces'
export function TaskPageLinearCustomViewList({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    selectedLinearWorkspaceId,
    linearCustomViewsResult,
    linearCustomViewsLoading,
    linearCustomViewsError,
    openLinearCustomViewContext
  } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground grid-cols-[minmax(220px,1.5fr)_120px_120px_120px_130px_60px]">
        <span>{translate('auto.components.TaskPage.9c57663908', 'View')}</span>
        <span>{translate('auto.components.TaskPage.0aa8525950', 'Model')}</span>
        <span>{translate('auto.components.TaskPage.a04fe7ba73', 'Visibility')}</span>
        <span>{translate('auto.components.TaskPage.b4e10f096e', 'Owner')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
        {linearCustomViewsError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {linearCustomViewsError}
          </div>
        ) : null}
        <LinearCustomViewTable
          views={linearCustomViewsResult.items}
          loading={linearCustomViewsLoading}
          hasError={!!linearCustomViewsResult.errors?.length}
          workspaceSelection={selectedLinearWorkspaceId}
          onSelectView={openLinearCustomViewContext}
          onOpenView={(view) => {
            if (view.url) {
              void window.api.shell.openUrl(view.url)
            }
          }}
        />
      </div>
      <LinearCollectionNotice
        errors={linearCustomViewsResult.errors}
        hasMore={linearCustomViewsResult.hasMore}
        count={linearCustomViewsResult.items.length}
        label={translate('auto.components.TaskPage.3cb855080f', 'views')}
      />
    </div>
  )
}
