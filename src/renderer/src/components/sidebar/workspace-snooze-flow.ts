import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { runSleepWorktrees } from './sleep-worktree-flow'

export type SnoozeTarget = Pick<Worktree, 'id' | 'hostId'>

async function writeSnooze(
  worktrees: readonly SnoozeTarget[],
  snooze: WorktreeMeta['snooze']
): Promise<{ succeededIds: string[]; errors: string[] }> {
  const { updateWorktreeMeta } = useAppStore.getState()
  const results = await Promise.all(
    worktrees.map(async (worktree) => ({
      id: worktree.id,
      result: await updateWorktreeMeta(
        worktree.id,
        { snooze },
        { executionHostId: worktree.hostId ?? 'local' }
      )
    }))
  )
  const succeededIds: string[] = []
  const errors: string[] = []
  for (const { id, result } of results) {
    if (result.ok) {
      succeededIds.push(id)
    } else {
      errors.push(result.error)
    }
  }
  return { succeededIds, errors }
}

/** Persists the snooze first so a failed write never leaves a workspace slept but visible. */
export async function snoozeWorkspaces(
  worktrees: readonly SnoozeTarget[],
  wakeAt: number
): Promise<void> {
  const { succeededIds, errors } = await writeSnooze(worktrees, {
    snoozedAt: Date.now(),
    wakeAt
  })
  if (errors.length > 0) {
    toast.error(
      translate(
        'auto.components.sidebar.workspaceSnooze.snoozeFailed',
        'Failed to snooze workspace'
      ),
      { description: errors.join('\n') }
    )
  }
  await runSleepWorktrees(succeededIds)
}

export async function wakeSnoozedWorkspaces(worktrees: readonly SnoozeTarget[]): Promise<void> {
  const { errors } = await writeSnooze(worktrees, null)
  if (errors.length > 0) {
    toast.error(
      translate('auto.components.sidebar.workspaceSnooze.wakeFailed', 'Failed to wake workspace'),
      { description: errors.join('\n') }
    )
  }
}
