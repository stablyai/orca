import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { LinearProjectOverview } from '@/components/linear-project-view-surfaces'
export function TaskPageLinearProjectOverview({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    setTaskResumeState,
    setLinearMode,
    setLinearRefreshNonce,
    selectedLinearProject,
    setSelectedLinearProject,
    selectedLinearProjectDetail,
    setSelectedLinearProjectDetail,
    linearProjectDetailLoading,
    linearProjectDetailError,
    setLinearProjectTab,
    setSelectedLinearCustomView,
    linearProjectParentView,
    setLinearProjectParentView
  } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <LinearProjectOverview
        project={selectedLinearProjectDetail ?? selectedLinearProject}
        loading={linearProjectDetailLoading}
        error={linearProjectDetailError}
        onBack={() => {
          if (linearProjectParentView) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectTab('overview')
            setLinearMode('views')
            setSelectedLinearCustomView(linearProjectParentView)
            setTaskResumeState(
              linearProjectParentView.workspaceId
                ? {
                    linearMode: 'views',
                    linearContext: {
                      kind: 'view',
                      id: linearProjectParentView.id,
                      workspaceId: linearProjectParentView.workspaceId,
                      model: linearProjectParentView.model
                    }
                  }
                : {
                    linearMode: 'views',
                    linearContext: undefined
                  }
            )
            setLinearProjectParentView(null)
            return
          }
          setSelectedLinearProject(null)
          setSelectedLinearProjectDetail(null)
          setLinearProjectParentView(null)
          setLinearProjectTab('overview')
          setTaskResumeState({
            linearContext: undefined
          })
        }}
        onOpenProject={(project) => {
          if (project.url) {
            void window.api.shell.openUrl(project.url)
          }
        }}
        onRefresh={() => setLinearRefreshNonce((n) => n + 1)}
        onOpenIssues={() => setLinearProjectTab('issues')}
      />
    </div>
  )
}
