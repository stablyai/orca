import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import {
  collectWorkspaceTags,
  planTagDelete,
  planTagRename,
  planTagToggle,
  type WorkspaceTagSummary,
  type WorkspaceTagUpdate
} from './workspace-tag-actions'

export type WorkspaceTagCommands = {
  allTags: WorkspaceTagSummary[]
  /** Current store rows for a captured selection; menus snapshot rows when they open. */
  resolveLive: (workspaces: readonly Worktree[]) => Worktree[]
  toggleTag: (workspaces: readonly Worktree[], tag: string) => Promise<void>
  renameTag: (from: string, to: string) => Promise<void>
  deleteTag: (tag: string) => Promise<void>
  countTagged: (tag: string) => number
}

/** Tag reads and writes over every workspace the sidebar knows, git worktrees and folders alike. */
export function useWorkspaceTagCommands(): WorkspaceTagCommands {
  const worktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)

  const allWorkspaces = useMemo(
    () => [
      ...worktrees,
      ...folderWorkspaces.map((workspace) => folderWorkspaceToWorktree(workspace))
    ],
    [worktrees, folderWorkspaces]
  )
  const allTags = useMemo(() => collectWorkspaceTags(allWorkspaces), [allWorkspaces])
  const resolveLive = useCallback(
    (workspaces: readonly Worktree[]) => {
      const live = new Map(allWorkspaces.map((entry) => [getWorktreeHostIdentity(entry), entry]))
      return workspaces.map((entry) => live.get(getWorktreeHostIdentity(entry)) ?? entry)
    },
    [allWorkspaces]
  )

  const apply = useCallback(
    async (updates: WorkspaceTagUpdate<Worktree>[]) => {
      const results = await Promise.all(
        updates.map(({ workspace, tags }) =>
          updateWorktreeMeta(
            workspace.id,
            { tags },
            { executionHostId: workspace.hostId ?? 'local' }
          )
        )
      )
      const failure = results.find((result) => !result.ok)
      if (failure && !failure.ok) {
        toast.error(
          translate('auto.components.sidebar.workspaceTags.updateFailed', 'Could not update tags'),
          { description: failure.error }
        )
      }
    },
    [updateWorktreeMeta]
  )

  const toggleTag = useCallback(
    // Why live rows: planning from the snapshot would drop a tag toggled moments earlier.
    (workspaces: readonly Worktree[], tag: string) =>
      apply(planTagToggle(resolveLive(workspaces), tag)),
    [apply, resolveLive]
  )
  const renameTag = useCallback(
    (from: string, to: string) => apply(planTagRename(allWorkspaces, from, to)),
    [allWorkspaces, apply]
  )
  const deleteTag = useCallback(
    (tag: string) => apply(planTagDelete(allWorkspaces, tag)),
    [allWorkspaces, apply]
  )
  const countTagged = useCallback(
    (tag: string) => planTagDelete(allWorkspaces, tag).length,
    [allWorkspaces]
  )

  return { allTags, resolveLive, toggleTag, renameTag, deleteTag, countTagged }
}
