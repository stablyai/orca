import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { worktreeTagKey } from '../../../../shared/worktree/worktree-tags'
import {
  collectWorkspaceTags,
  countAtTagLimit,
  planTagAdd,
  planTagDelete,
  planTagRename,
  planTagToggle,
  type WorkspaceTagSummary
} from './workspace-tag-actions'
import { enqueueTagWrite } from './workspace-tag-writes'

export type WorkspaceTagCommands = {
  allTags: WorkspaceTagSummary[]
  /** Current store rows for a captured selection; menus snapshot rows when they open. */
  resolveLive: (workspaces: readonly Worktree[]) => Worktree[]
  toggleTag: (workspaces: readonly Worktree[], tag: string) => Promise<void>
  /** Adds the tag named by its case-insensitive key to workspaces given by host-qualified identity. */
  addTagToIdentities: (identities: readonly string[], tagKey: string) => Promise<void>
  renameTag: (from: string, to: string) => Promise<void>
  deleteTag: (tag: string) => Promise<void>
  countTagged: (tag: string) => number
}

function byIdentity(workspaces: Worktree[], identities: ReadonlySet<string>): Worktree[] {
  return workspaces.filter((entry) => identities.has(getWorktreeHostIdentity(entry)))
}

/** Tag reads for rendering, and queued tag writes over git worktrees and folder workspaces alike. */
export function useWorkspaceTagCommands(): WorkspaceTagCommands {
  const worktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)

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

  const toggleTag = useCallback((workspaces: readonly Worktree[], tag: string) => {
    const identities = new Set(workspaces.map(getWorktreeHostIdentity))
    return enqueueTagWrite((all) => {
      const targets = byIdentity(all, identities)
      return { updates: planTagToggle(targets, tag), atLimitCount: countAtTagLimit(targets, tag) }
    })
  }, [])
  const addTagToIdentities = useCallback((identities: readonly string[], tagKey: string) => {
    const wanted = new Set(identities)
    return enqueueTagWrite((all) => {
      const tag = collectWorkspaceTags(all).find(
        (entry) => worktreeTagKey(entry.tag) === tagKey
      )?.tag
      if (!tag) {
        return { updates: [] }
      }
      const targets = byIdentity(all, wanted)
      return { updates: planTagAdd(targets, tag), atLimitCount: countAtTagLimit(targets, tag) }
    })
  }, [])
  const renameTag = useCallback(
    (from: string, to: string) =>
      enqueueTagWrite((all) => ({ updates: planTagRename(all, from, to) })),
    []
  )
  const deleteTag = useCallback(
    (tag: string) => enqueueTagWrite((all) => ({ updates: planTagDelete(all, tag) })),
    []
  )
  const countTagged = useCallback(
    (tag: string) => planTagDelete(allWorkspaces, tag).length,
    [allWorkspaces]
  )

  return { allTags, resolveLive, toggleTag, addTagToIdentities, renameTag, deleteTag, countTagged }
}
