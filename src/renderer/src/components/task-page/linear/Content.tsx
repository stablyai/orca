import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import LinearIssueWorkspace from '@/components/LinearIssueWorkspace'
import { LoaderCircle } from 'lucide-react'
import { LinearIcon } from '@/components/task-page-localized-options'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TaskPageLinearProjectOverview } from './ProjectOverview'
import { TaskPageLinearProjectList } from './ProjectList'
import { TaskPageLinearCustomViewList } from './CustomViewList'
import { TaskPageLinearCustomViewProjects } from './CustomViewProjects'
import { TaskPageLinearIssueList } from './IssueList'
export function TaskPageLinearContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    linearStatusReady,
    linearConnected,
    taskSource,
    selectedLinearIssue,
    linearDetailSourceContext,
    openRelatedLinearIssue,
    closeTaskDetailPage,
    linearMode,
    selectedLinearProject,
    linearProjectTab,
    selectedLinearCustomView,
    activeLinearIssueContextLabel,
    setLinearConnectOpen,
    handleUseLinearItem
  } = model
  return taskSource === 'linear' && selectedLinearIssue ? (
    <LinearIssueWorkspace
      issue={selectedLinearIssue}
      variant="page"
      backLabel={activeLinearIssueContextLabel ?? 'Linear list'}
      onUse={handleUseLinearItem}
      onOpenIssue={openRelatedLinearIssue}
      onClose={closeTaskDetailPage}
      sourceContext={linearDetailSourceContext}
    />
  ) : !linearStatusReady ? (
    <div className="mt-4 flex items-center justify-center py-14">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
    </div>
  ) : !linearConnected ? (
    <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
      <LinearIcon className="mb-4 size-8 text-muted-foreground/60" />
      <p className="text-base font-medium text-foreground">
        {translate('auto.components.TaskPage.6d56559467', 'Connect your Linear account')}
      </p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {translate(
          'auto.components.TaskPage.228b25028f',
          'Browse and start work on your assigned Linear issues directly from here.'
        )}
      </p>
      <Button
        className="mt-5"
        onClick={() => {
          setLinearConnectOpen(true)
        }}
      >
        {translate('auto.components.TaskPage.851017590d', 'Add Linear access')}
      </Button>
    </div>
  ) : selectedLinearProject && linearProjectTab === 'overview' ? (
    <TaskPageLinearProjectOverview model={model} />
  ) : linearMode === 'projects' && !selectedLinearProject ? (
    <TaskPageLinearProjectList model={model} />
  ) : linearMode === 'views' && !selectedLinearCustomView ? (
    <TaskPageLinearCustomViewList model={model} />
  ) : selectedLinearCustomView?.model === 'project' && !selectedLinearProject ? (
    <TaskPageLinearCustomViewProjects model={model} />
  ) : (
    <TaskPageLinearIssueList model={model} />
  )
}
