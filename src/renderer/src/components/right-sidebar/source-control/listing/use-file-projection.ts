import { useMemo } from 'react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import { compareFileNames } from '../../../../../../shared/file-name-sort'
import { compareGitStatusEntries } from '../../source-control-status-sort'
import {
  filterSourceControlGroupedPathEntries,
  filterSourceControlPathEntries,
  getSourceControlFileFilterState,
  type SourceControlFileFilterState
} from './file-filter'
import {
  applyGitStatusEntryAreasToSourceControlTree,
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  namespaceSourceControlTreeDirectoryKeys,
  type SourceControlTreeNode
} from '../../source-control-tree'
import {
  buildSourceControlDisplaySections,
  SOURCE_CONTROL_AREAS,
  type SourceControlDisplaySection,
  type SourceControlDisplaySectionId,
  type SourceControlEntryGroups,
  type SourceControlSectionArea
} from './section-order'
import {
  collectListSelectionEntries,
  injectExpandedSubmoduleEntries,
  injectExpandedSubmoduleRows,
  type RenderableSourceControlNode,
  type RenderableSubmoduleListItem,
  type SubmoduleStatusState
} from './submodule-expansion'
import type { FlatEntry } from './use-selection'
import type { GitStatusSourceControlTreeNode } from './directory-action-paths'
import { SUBMODULE_EMPTY_LABEL, SUBMODULE_LOADING_LABEL } from './row-layout'

export type SourceControlFileProjection = {
  grouped: SourceControlEntryGroups
  fileFilterState: SourceControlFileFilterState
  normalizedFilter: string
  isGitHistoryVisible: boolean
  filteredGrouped: SourceControlEntryGroups
  displaySections: SourceControlDisplaySection[]
  unfilteredDisplaySectionsById: ReadonlyMap<
    SourceControlDisplaySectionId,
    SourceControlDisplaySection
  >
  filteredBranchEntries: GitBranchChangeEntry[]
  visibleTreeRowsBySection: Partial<
    Record<SourceControlDisplaySectionId, RenderableSourceControlNode[]>
  >
  visibleListRowsBySection: Partial<
    Record<SourceControlDisplaySectionId, RenderableSubmoduleListItem[]>
  >
  visibleBranchTreeRows: readonly SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[]
  visibleSelectionEntries: FlatEntry[]
}

// Why: only one view mode is ever rendered, so building the other mode's projection is pure dead
// work (precedent: the combined-diff file tree short-circuits the same way while collapsed).
// The gates below and both branching consumers (section-file-list.tsx, branch-section.tsx) read the
// same sourceControlViewMode prop within one synchronous render, so a mode switch can never show
// these. Keep that single source: deriving the mode from a separate store read would let a consumer
// switch a render before the memos do, and only then could one of these reach the screen.
const EMPTY_TREE_ROOTS_BY_SECTION: Readonly<
  Partial<Record<SourceControlDisplaySectionId, GitStatusSourceControlTreeNode[]>>
> = Object.freeze({})
const EMPTY_TREE_ROWS_BY_SECTION: Readonly<
  Partial<Record<SourceControlDisplaySectionId, RenderableSourceControlNode[]>>
> = Object.freeze({})
const EMPTY_LIST_ROWS_BY_SECTION: Readonly<
  Partial<Record<SourceControlDisplaySectionId, RenderableSubmoduleListItem[]>>
> = Object.freeze({})
const EMPTY_BRANCH_TREE_NODES: readonly SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[] =
  Object.freeze([])

export function useSourceControlFileProjection({
  entries,
  branchEntries,
  filterQuery,
  sourceControlGroupOrder,
  activeWorktreeId,
  worktreePath,
  isFolder,
  collapsedTreeDirs,
  expandedSubmoduleKeys,
  submoduleStatusByKey,
  sourceControlViewMode,
  collapsedSections
}: {
  entries: GitStatusEntry[]
  branchEntries: GitBranchChangeEntry[]
  filterQuery: string
  sourceControlGroupOrder: readonly SourceControlSectionArea[]
  activeWorktreeId: string | null
  worktreePath: string | null
  isFolder: boolean
  collapsedTreeDirs: Set<string>
  expandedSubmoduleKeys: Set<string>
  submoduleStatusByKey: Record<string, SubmoduleStatusState>
  sourceControlViewMode: SourceControlViewMode
  collapsedSections: Set<string>
}): SourceControlFileProjection {
  const grouped = useMemo(() => {
    const groups: SourceControlEntryGroups = {
      staged: [],
      unstaged: [],
      untracked: []
    }
    for (const entry of entries) {
      groups[entry.area].push(entry)
    }
    for (const area of SOURCE_CONTROL_AREAS) {
      groups[area].sort(compareGitStatusEntries)
    }
    return groups
  }, [entries])

  const fileFilterState = useMemo(() => getSourceControlFileFilterState(filterQuery), [filterQuery])
  const normalizedFilter = fileFilterState.normalizedFilter
  const isGitHistoryVisible =
    !normalizedFilter &&
    !fileFilterState.tooLarge &&
    Boolean(activeWorktreeId && worktreePath && !isFolder)

  const filteredGrouped = useMemo(
    () => filterSourceControlGroupedPathEntries(grouped, fileFilterState),
    [fileFilterState, grouped]
  )

  const displaySections = useMemo(
    () => buildSourceControlDisplaySections(filteredGrouped, sourceControlGroupOrder),
    [filteredGrouped, sourceControlGroupOrder]
  )
  const unfilteredDisplaySections = useMemo(
    () => buildSourceControlDisplaySections(grouped, sourceControlGroupOrder),
    [grouped, sourceControlGroupOrder]
  )
  const unfilteredDisplaySectionsById = useMemo(
    () => new Map(unfilteredDisplaySections.map((section) => [section.id, section])),
    [unfilteredDisplaySections]
  )

  // Why: sorting before filtering keeps the collator off the keystroke path, and is order-identical
  // to the old filter-then-sort for any self-consistent comparator (a total order is not required):
  // a stable sort fixes each element's position by (comparator result, original index), and
  // Array#filter drops elements without disturbing either, so re-sorting the survivors would
  // reproduce the same relative order. filter(sort(x)) === sort(filter(x)).
  const sortedBranchEntries = useMemo(
    () => [...branchEntries].sort((a, b) => compareFileNames(a.path, b.path)),
    [branchEntries]
  )
  const filteredBranchEntries = useMemo(
    () => filterSourceControlPathEntries(sortedBranchEntries, fileFilterState),
    [fileFilterState, sortedBranchEntries]
  )

  const treeRootsBySection = useMemo(() => {
    if (sourceControlViewMode !== 'tree') {
      return EMPTY_TREE_ROOTS_BY_SECTION
    }
    const roots: Partial<Record<SourceControlDisplaySectionId, GitStatusSourceControlTreeNode[]>> =
      {}
    for (const section of displaySections) {
      const sectionRoots = compactSourceControlTree(
        buildGitStatusSourceControlTree(section.area, section.items)
      )
      roots[section.id] =
        section.id === 'conflicts'
          ? applyGitStatusEntryAreasToSourceControlTree(
              // Why: conflict rows can mirror normal paths, so their folder collapse keys must not share state with normal sections.
              namespaceSourceControlTreeDirectoryKeys(sectionRoots, 'conflicts')
            )
          : sectionRoots
    }
    return roots
  }, [displaySections, sourceControlViewMode])

  const visibleTreeRowsBySection = useMemo(() => {
    if (sourceControlViewMode !== 'tree') {
      return EMPTY_TREE_ROWS_BY_SECTION
    }
    const rows: Partial<Record<SourceControlDisplaySectionId, RenderableSourceControlNode[]>> = {}
    for (const section of displaySections) {
      rows[section.id] = injectExpandedSubmoduleRows(
        flattenSourceControlTree(treeRootsBySection[section.id] ?? [], collapsedTreeDirs),
        expandedSubmoduleKeys,
        submoduleStatusByKey,
        SUBMODULE_LOADING_LABEL,
        SUBMODULE_EMPTY_LABEL
      )
    }
    return rows
  }, [
    collapsedTreeDirs,
    displaySections,
    treeRootsBySection,
    expandedSubmoduleKeys,
    sourceControlViewMode,
    submoduleStatusByKey
  ])

  // List view needs the same lazy submodule expansion as tree view, spliced into the flat entry list.
  const visibleListRowsBySection = useMemo(() => {
    if (sourceControlViewMode !== 'list') {
      return EMPTY_LIST_ROWS_BY_SECTION
    }
    const rows: Partial<Record<SourceControlDisplaySectionId, RenderableSubmoduleListItem[]>> = {}
    for (const section of displaySections) {
      rows[section.id] = injectExpandedSubmoduleEntries(
        section.items,
        expandedSubmoduleKeys,
        submoduleStatusByKey,
        SUBMODULE_LOADING_LABEL,
        SUBMODULE_EMPTY_LABEL
      )
    }
    return rows
  }, [displaySections, expandedSubmoduleKeys, sourceControlViewMode, submoduleStatusByKey])

  const branchTreeRoots = useMemo(
    () =>
      sourceControlViewMode === 'tree'
        ? compactSourceControlTree(buildSourceControlTree('branch', filteredBranchEntries))
        : EMPTY_BRANCH_TREE_NODES,
    [filteredBranchEntries, sourceControlViewMode]
  )
  const visibleBranchTreeRows = useMemo(
    () =>
      sourceControlViewMode === 'tree'
        ? flattenSourceControlTree(branchTreeRoots, collapsedTreeDirs)
        : EMPTY_BRANCH_TREE_NODES,
    [branchTreeRoots, collapsedTreeDirs, sourceControlViewMode]
  )

  const visibleSelectionEntries = useMemo(() => {
    const arr: FlatEntry[] = []
    // Why: list view splices in lazy submodule rows, so selection/range bookkeeping must read the injected rows, not the pre-injection entries.
    if (sourceControlViewMode === 'list') {
      for (const section of displaySections) {
        if (collapsedSections.has(section.id)) {
          continue
        }
        arr.push(...collectListSelectionEntries(visibleListRowsBySection[section.id] ?? []))
      }
      return arr
    }

    for (const section of displaySections) {
      if (collapsedSections.has(section.id)) {
        continue
      }
      for (const node of visibleTreeRowsBySection[section.id] ?? []) {
        if (node.type === 'file') {
          arr.push({ key: node.key, entry: node.entry, area: node.area })
        }
      }
    }
    return arr
  }, [
    collapsedSections,
    displaySections,
    sourceControlViewMode,
    visibleListRowsBySection,
    visibleTreeRowsBySection
  ])
  return {
    grouped,
    fileFilterState,
    normalizedFilter,
    isGitHistoryVisible,
    filteredGrouped,
    displaySections,
    unfilteredDisplaySectionsById,
    filteredBranchEntries,
    visibleTreeRowsBySection,
    visibleListRowsBySection,
    visibleBranchTreeRows,
    visibleSelectionEntries
  }
}
