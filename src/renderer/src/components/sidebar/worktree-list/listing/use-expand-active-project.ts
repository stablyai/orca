import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import { showsProjectChats } from '../../../../../../shared/sidebar-list/project-tree-settings'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { OccurrenceSectionPath } from '../../../../../../shared/sidebar-list/lineage/worktree-occurrence-plan'

type SectionLike = {
  key: string
  group: { repoIds: ReadonlySet<string> }
  revealPath?: OccurrenceSectionPath
}

/** Project tree: opens the active workspace's project (and its groups) when you switch to it; later collapses stick. */
export function useExpandActiveProject(
  sections: readonly SectionLike[],
  groupBy: WorktreeGroupBy
): void {
  const enabled = useAppStore((s) => showsProjectChats(s.settings, groupBy))
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeRepoId =
    enabled && activeWorktreeId ? getRepoIdFromWorktreeId(activeWorktreeId) : null
  // Only a switch opens the project; at launch the saved collapse state stands. Section
  // changes rerun the effect but stop here while the project stays the same.
  const previousRepoIdRef = useRef(activeRepoId)
  useEffect(() => {
    if (!activeRepoId) {
      previousRepoIdRef.current = null
      return
    }
    if (activeRepoId === previousRepoIdRef.current) {
      return
    }
    const section = sections.find((candidate) => candidate.group.repoIds.has(activeRepoId))
    if (!section) {
      // The switch stays pending until the project's section is listed (a filter may hide it).
      return
    }
    previousRepoIdRef.current = activeRepoId
    const keys = new Set<string>()
    for (let path = section.revealPath; path; path = path.parent) {
      keys.add(path.key)
    }
    const { collapsedGroups, setCollapsedGroups } = useAppStore.getState()
    if ([...keys].some((key) => collapsedGroups.has(key))) {
      setCollapsedGroups(new Set([...collapsedGroups].filter((key) => !keys.has(key))))
    }
  }, [activeRepoId, sections])
}
