import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageSourceBar } from './SourceBar'
import { AlertCircle } from 'lucide-react'
import { RailPageHeader } from '@/components/rail-page/RailPageHeader'
import { RailPageToolbar } from '@/components/rail-page/RailPageToolbar'
import { RailPageNotice } from '@/components/rail-page/RailPage'
import { useTranslate } from '@/i18n/use-translate'

type Props = { model: TaskPageComposerActionsModel }

export function TaskPageListBands({
  model,
  scope,
  actions,
  views,
  controls,
  notices
}: Props & {
  scope?: React.ReactNode
  actions?: React.ReactNode
  views?: React.ReactNode
  controls?: React.ReactNode
  notices?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { closeTaskPage, taskSourceAvailabilityNotice, taskSourceContextSummary } = model
  const { taskSource, taskSourceRepoContexts, accountBackedTaskSourceHostId } = model
  const showContext =
    taskSource === 'github' || taskSource === 'gitlab'
      ? taskSourceRepoContexts.some(({ hostId }) => hostId !== 'local')
      : accountBackedTaskSourceHostId !== 'local'
  return (
    <>
      <RailPageHeader
        title={t('worktreeJumpPalette.tasksHeader', 'Tasks')}
        close={{
          label: t('auto.components.TaskPage.1a06219d5c', 'Close tasks'),
          tooltip: t('auto.components.TaskPage.4826fd1ad8', 'Close · Esc'),
          onClose: closeTaskPage
        }}
        scope={
          <>
            <TaskPageSourceBar model={model} />
            {scope}
          </>
        }
        meta={showContext ? taskSourceContextSummary.label : undefined}
        metaTitle={taskSourceContextSummary.title}
        actions={
          actions ? (
            <div className="flex items-center gap-1.5" data-contextual-tour-target="tasks-actions">
              {actions}
            </div>
          ) : null
        }
      />
      {views || controls ? (
        <RailPageToolbar
          start={views}
          end={controls}
          endProps={{ 'data-contextual-tour-target': 'tasks-search-presets' }}
        />
      ) : null}
      {taskSourceAvailabilityNotice || notices ? (
        <RailPageNotice>
          {taskSourceAvailabilityNotice ? (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={taskSourceAvailabilityNotice.title}
            >
              <AlertCircle className="size-3.5 flex-none" />
              <span className="min-w-0 truncate">{taskSourceAvailabilityNotice.label}</span>
            </div>
          ) : null}
          {notices}
        </RailPageNotice>
      ) : null}
    </>
  )
}
