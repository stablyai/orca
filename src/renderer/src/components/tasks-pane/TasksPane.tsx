import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import type { TaskPageEmbedContext } from '@/components/task-page-embed-surface'

const TaskPage = lazy(() => import('@/components/TaskPage'))

type TasksPaneProps = {
  worktreeId: string
  isActive: boolean
}

export default function TasksPane({ worktreeId, isActive }: TasksPaneProps): React.JSX.Element {
  const worktreeRepoId = useAppStore(
    (s) => s.getKnownWorktreeById(worktreeId)?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  )
  const repo = useAppStore((s) => s.repos.find((r) => r.id === worktreeRepoId) ?? null)

  // Why: overlay panes mount for every restored tab at startup; defer the
  // heavy TaskPage bundle + fetches until the tab is first shown.
  const [hasBeenActive, setHasBeenActive] = useState(isActive)
  useEffect(() => {
    if (isActive) {
      setHasBeenActive(true)
    }
  }, [isActive])

  const embed = useMemo<TaskPageEmbedContext>(
    () => ({ worktreeId, lockedRepoId: worktreeRepoId, isActive }),
    [isActive, worktreeId, worktreeRepoId]
  )

  if (!repo || !isGitRepoKind(repo)) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 bg-background px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          {translate('auto.components.tasks.pane.TasksPane.a81bfba116', 'Tasks unavailable')}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.tasks.pane.TasksPane.36a1cd05e1',
            'This workspace is not backed by a git repository, so there is no task source to show.'
          )}
        </p>
      </div>
    )
  }

  if (!hasBeenActive) {
    return <div className="h-full min-h-0 bg-background" />
  }

  return (
    // Why: data marker lets useModalReturnFocus route focus back into this
    // pane after a modal closes (mirrors data-orca-emulator-frame).
    <div className="h-full min-h-0 overflow-hidden bg-background" data-orca-tasks-pane="true">
      <Suspense fallback={<div className="h-full min-h-0 bg-background" />}>
        <TaskPage embed={embed} />
      </Suspense>
    </div>
  )
}
