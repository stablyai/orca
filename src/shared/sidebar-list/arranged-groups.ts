import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { CompiledListArrangement } from '../workspace-lists/compile-list-arrangement'
import {
  buildWorkspaceListFacts,
  type WorkspaceListFacts
} from '../workspace-lists/workspace-list-facts'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import type { RepoOfWorktree, SidebarPRGroupReader } from './row-types'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'

/** A plugin list arrangement the planner draws instead of Orca's grouping. */
export type SidebarListArrangement = {
  listId: string
  compiled: CompiledListArrangement
}

const LIST_SECTION_KEY_PREFIX = 'list:'

export function getListSectionKey(listId: string, sectionId: string): string {
  return `${LIST_SECTION_KEY_PREFIX}${listId}:${sectionId}`
}

export function isListSectionKey(key: string): boolean {
  return key.startsWith(LIST_SECTION_KEY_PREFIX)
}

/** Sections in declared order, each holding the workspaces whose first matching rule it is,
 *  ordered by the arrangement's sort keys with the person's own order breaking ties. */
export function buildArrangedGroups(args: {
  arrangement: SidebarListArrangement
  naturalWorktrees: readonly Worktree[]
  repoOf: RepoOfWorktree
  prGroupOf: SidebarPRGroupReader
  folderWorkspaces: readonly RenderableFolderWorkspace[]
}): OrderedGroupEntry[] {
  const { compiled, listId } = args.arrangement
  const groups: (WorktreeGroupEntry & { facts: WorkspaceListFacts[] })[] = compiled.sections.map(
    (section) => ({ label: section.title, items: [], repoIds: new Set<string>(), facts: [] })
  )
  for (const worktree of args.naturalWorktrees) {
    const repo: Repo | undefined = args.repoOf(worktree)
    const facts = buildWorkspaceListFacts(worktree, repo, args.prGroupOf(worktree))
    const group = groups[compiled.sectionOf(facts)]
    if (group) {
      group.items.push(worktree)
      group.facts.push(facts)
      group.repoIds.add(worktree.repoId)
    }
  }
  // Folder workspaces have no worktree facts; they join the last section.
  const folderGroup = groups.at(-1)
  if (folderGroup && args.folderWorkspaces.length > 0) {
    folderGroup.folderWorkspaces = [...args.folderWorkspaces].sort((left, right) =>
      compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
    )
  }
  const ordered: OrderedGroupEntry[] = []
  groups.forEach((group, index) => {
    const section = compiled.sections[index]
    if (!section || (group.items.length === 0 && !group.folderWorkspaces?.length)) {
      return
    }
    // Stable sort: equal keys keep the person's own sort order.
    const order = group.items.map((_item, position) => position)
    order.sort((a, b) => compiled.compare(group.facts[a]!, group.facts[b]!))
    ordered.push([
      getListSectionKey(listId, section.id),
      {
        label: group.label,
        items: order.map((position) => group.items[position]!),
        repoIds: group.repoIds,
        ...(group.folderWorkspaces ? { folderWorkspaces: group.folderWorkspaces } : {})
      }
    ])
  })
  return ordered
}
