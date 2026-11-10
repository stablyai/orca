import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { createPinnedGroup } from '@/store/pinned-groups/pinned-group-actions'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getSidebarLineageParentsByIdentity } from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import { getSidebarLineageRowsByIdentity } from '../../../../../../shared/sidebar-list/pinned-section-worktrees'

export function useWorktreePinnedGroupMenu(args: {
  worktree: Worktree
  menuOpen: boolean
  allWorktrees: readonly Worktree[]
  worktreeMap: ReadonlyMap<string, Worktree>
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  projectGroupCommands: {
    handleCreateGroupDialogOpenChange: (open: boolean) => void
    handleCreateGroupFromRepo: () => void
    handleSubmitNewProjectGroup: (name: string) => Promise<void>
  }
}) {
  const { worktree, menuOpen, allWorktrees, worktreeMap, worktreeLineageById } = args
  const pinnedGroups = useAppStore((s) => (menuOpen ? s.settings?.pinnedGroups : undefined))
  const pinnedGroupByWorktreeIdentity = useAppStore((s) =>
    menuOpen ? s.settings?.pinnedGroupByWorktreeIdentity : undefined
  )
  const [dialogWorktree, setDialogWorktree] = useState<Worktree | null>(null)
  const pinnedGroupWorktree = useMemo(() => {
    if (!menuOpen) {
      return worktree.isPinned ? worktree : null
    }
    const parents = getSidebarLineageParentsByIdentity(
      worktreeLineageById,
      getSidebarLineageRowsByIdentity(allWorktrees, worktreeMap)
    )
    let current = worktree
    let pinnedRoot = worktree.isPinned ? worktree : null
    const visited = new Set<string>()
    while (!visited.has(getWorktreeHostIdentity(current))) {
      visited.add(getWorktreeHostIdentity(current))
      const parent = parents.get(getWorktreeHostIdentity(current))
      if (!parent) {
        break
      }
      if (parent.isPinned) {
        pinnedRoot = parent
      }
      current = parent
    }
    return pinnedRoot
  }, [menuOpen, worktree, allWorktrees, worktreeMap, worktreeLineageById])
  return {
    pinnedGroups,
    pinnedGroupByWorktreeIdentity,
    pinnedGroupWorktree,
    isPinnedGroupDialog: dialogWorktree !== null,
    handleCreateGroupFromRepo: () => {
      setDialogWorktree(null)
      args.projectGroupCommands.handleCreateGroupFromRepo()
    },
    handleSubmitNewProjectGroup: (name: string) =>
      dialogWorktree
        ? createPinnedGroup(name, dialogWorktree)
        : args.projectGroupCommands.handleSubmitNewProjectGroup(name),
    handleCreatePinnedGroup: () => {
      setDialogWorktree(pinnedGroupWorktree)
      args.projectGroupCommands.handleCreateGroupDialogOpenChange(true)
    }
  }
}
