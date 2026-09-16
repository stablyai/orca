import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import PullRequestPage from '@/components/PullRequestPage'
import GitHubItemDialog from '@/components/GitHubItemDialog'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'
import { TaskPageGitHubList } from './github/List'
import { TaskPageGitLabTodoList } from './gitlab/TodoList'
import { TaskPageGitLabItemList } from './gitlab/ItemList'
import { TaskPageJiraContent } from './jira/Content'
export function TaskPageContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    repoSelection,
    taskSource,
    githubMode,
    gitlabView,
    dialogInitialTab,
    dialogWorkItem,
    dialogRepoPath,
    dialogSourceContext,
    setDialogWorkItem,
    handleDialogReviewRequestsChange,
    closeTaskDetailPage,
    handleUseWorkItem
  } = model
  return taskSource === 'github' && dialogWorkItem ? (
    dialogWorkItem.type === 'pr' ? (
      <PullRequestPage
        workItem={dialogWorkItem}
        initialTab={dialogInitialTab}
        repoPath={dialogRepoPath}
        repoId={dialogWorkItem.repoId}
        sourceContext={dialogSourceContext}
        backLabel="Pull requests"
        onUse={(item) => {
          setDialogWorkItem(null)
          handleUseWorkItem(item)
        }}
        onReviewRequestsChange={handleDialogReviewRequestsChange}
        onClose={closeTaskDetailPage}
      />
    ) : (
      <GitHubItemDialog
        workItem={dialogWorkItem}
        initialTab={dialogInitialTab}
        repoPath={dialogRepoPath}
        repoId={dialogWorkItem.repoId}
        sourceContext={dialogSourceContext}
        backLabel="GitHub list"
        onUse={(item) => {
          setDialogWorkItem(null)
          handleUseWorkItem(item)
        }}
        onReviewRequestsChange={handleDialogReviewRequestsChange}
        onClose={closeTaskDetailPage}
      />
    )
  ) : taskSource === 'github' && githubMode === 'project' ? (
    <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <ProjectViewWrapper selectedRepoIds={repoSelection} />
    </div>
  ) : taskSource === 'github' ? (
    // Why: bottom of the joined GitHub list card — flush under the filter
    // chrome (no gap, no top border/radius) so toolbar + table read as one.
    <TaskPageGitHubList model={model} />
  ) : taskSource === 'gitlab' && gitlabView === 'todos' ? (
    <TaskPageGitLabTodoList model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabItemList model={model} />
  ) : (
    <TaskPageJiraContent model={model} />
  )
}
