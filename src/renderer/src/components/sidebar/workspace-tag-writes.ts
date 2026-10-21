import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceTagUpdate } from './workspace-tag-actions'

export type TagWritePlan = {
  updates: WorkspaceTagUpdate<Worktree>[]
  /** Workspaces left untouched because they already hold the maximum number of tags. */
  atLimitCount?: number
}

let tagWriteQueue: Promise<void> = Promise.resolve()

/** Every workspace the sidebar can tag, read from the store at call time. */
export function readAllTaggableWorkspaces(): Worktree[] {
  const state = useAppStore.getState()
  return [
    ...getAllWorktreesFromState(state),
    ...state.folderWorkspaces.map((workspace) => folderWorkspaceToWorktree(workspace))
  ]
}

/**
 * Runs tag writes one at a time, planning each from the store when its turn comes.
 * Why: folder-workspace writes land only after a round-trip, so a plan made earlier
 * (a second toggle, or a delete confirmed later) would overwrite fresher tags.
 */
export function enqueueTagWrite(plan: (workspaces: Worktree[]) => TagWritePlan): Promise<void> {
  const run = tagWriteQueue.then(async () => {
    const { updates, atLimitCount = 0 } = plan(readAllTaggableWorkspaces())
    const { updateWorktreeMeta } = useAppStore.getState()
    const results = await Promise.all(
      updates.map(({ workspace, tags }) =>
        updateWorktreeMeta(workspace.id, { tags }, { executionHostId: workspace.hostId ?? 'local' })
      )
    )
    const failure = results.find((result) => !result.ok)
    if (failure && !failure.ok) {
      toast.error(
        translate('auto.components.sidebar.workspaceTags.updateFailed', 'Could not update tags'),
        { description: failure.error }
      )
    }
    if (atLimitCount > 0) {
      toast.error(
        translate(
          'auto.components.sidebar.workspaceTags.limitReached',
          '{{value0}} workspace(s) already have the maximum of 32 tags',
          { value0: atLimitCount }
        )
      )
    }
  })
  tagWriteQueue = run.catch(() => {})
  return run
}
