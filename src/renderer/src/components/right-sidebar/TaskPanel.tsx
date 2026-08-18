import { useCallback, useMemo } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { resolveWorkspaceLinkedTask } from './workspace-linked-task'
import { TaskPanelLinkedItemCard } from './task-panel-linked-item-card'

const PullRequestPage = lazy(() => import('@/components/PullRequestPage'))
const GitHubItemDialog = lazy(() => import('@/components/GitHubItemDialog'))

/** The active workspace's linked work item, shown next to the work.
 *
 *  Why route to the provider's own detail view rather than render the item
 *  again: those views already own hydration, comments and edits. They are page
 *  surfaces, so the panel asks for their `panel` variant and the sidebar applies
 *  a width floor for this tab; below it the title column collapses next to the
 *  fixed-width workspace CTA. */
export default function TaskPanel(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const task = useMemo(() => resolveWorkspaceLinkedTask(worktree), [worktree])
  const repo = useRepoById(task?.repoId ?? null)
  // Why: the panel lives inside the workspace the item is already linked to, so
  // "start work from this item" and "go back" have nothing to do here.
  const noop = useCallback(() => {}, [])

  const workItem = useMemo<GitHubWorkItem | null>(() => {
    if (!task || task.provider !== 'github') {
      return null
    }
    // Why: a seed, not a fetched item. The view's own details read replaces every
    // field; `number` and `type` are what steer the lookup.
    return {
      id: `workspace-linked-task:${task.repoId ?? ''}:${task.type}:${task.number}`,
      type: task.type === 'pr' ? 'pr' : 'issue',
      number: task.number,
      title: task.title,
      state: 'open',
      url: task.url,
      labels: [],
      updatedAt: '',
      author: null,
      repoId: task.repoId ?? ''
    }
  }, [task])

  if (!task) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.TaskPanel.unlinked',
          'This workspace is not linked to a task.'
        )}
      </div>
    )
  }

  if (!workItem) {
    return <TaskPanelLinkedItemCard task={task} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {workItem.type === 'pr' ? (
        <PullRequestPage
          workItem={workItem}
          repoPath={repo?.path ?? null}
          repoId={task.repoId ?? null}
          sourceContext={task.sourceContext}
          variant="panel"
          onUse={noop}
          onClose={noop}
        />
      ) : (
        <GitHubItemDialog
          workItem={workItem}
          repoPath={repo?.path ?? null}
          repoId={task.repoId ?? null}
          sourceContext={task.sourceContext}
          variant="panel"
          onUse={noop}
          onClose={noop}
        />
      )}
    </div>
  )
}
