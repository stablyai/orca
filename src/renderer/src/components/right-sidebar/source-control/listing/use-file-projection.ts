import { useMemo } from 'react'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import { compareFileNames } from '../../../../../../shared/file-name-sort'
import {
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
  groupSourceControlEntries,
  type SourceControlDisplaySection,
  type SourceControlDisplaySectionId,
  type SourceControlEntryGroups,
  type SourceControlDisplaySectionArea
} from '../../../../../../shared/source-control-section-order'
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

// Build only the rendered mode; gates and consumers must use the same synchronous mode prop so empty projections cannot appear.
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
  sourceControlGroupOrder: readonly SourceControlDisplaySectionArea[]
  activeWorktreeId: string | null
  worktreePath: string | null
  isFolder: boolean
  collapsedTreeDirs: Set<string>
  expandedSubmoduleKeys: Set<string>
  submoduleStatusByKey: Record<string, SubmoduleStatusState>
  sourceControlViewMode: SourceControlViewMode
  collapsedSections: Set<string>
}): SourceControlFileProjection {
  const grouped = useMemo(() => groupSourceControlEntries(entries), [entries])

  const fileFilterState = useMemo(() => getSourceControlFileFilterState(filterQuery), [filterQuery])
  const normalizedFilter = fileFilterState.normalizedFilter
  const isGitHistoryVisible =
    !normalizedFilter &&
    !fileFilterState.tooLarge &&
    Boolean(activeWorktreeId && worktreePath && !isFolder)

  const unfilteredDisplaySections = useMemo(
    () => buildSourceControlDisplaySections(grouped, sourceControlGroupOrder),
    [grouped, sourceControlGroupOrder]
  )
  const displaySections = useMemo(
    () =>
      unfilteredDisplaySections
        .map((section) => ({
          ...section,
          items: filterSourceControlPathEntries(section.items, fileFilterState)
        }))
        .filter((section) => section.items.length > 0),
    [fileFilterState, unfilteredDisplaySections]
  )
  const unfilteredDisplaySectionsById = useMemo(
    () => new Map(unfilteredDisplaySections.map((section) => [section.id, section])),
    [unfilteredDisplaySections]
  )

  // Stable sorting commutes with filtering, including ties; sort once to keep collator work off keystrokes.
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
      // Conflict folders need section-local collapse keys even when their paths match Changes.
      roots[section.id] = applyGitStatusEntryAreasToSourceControlTree(
        section.id === 'conflicts'
          ? namespaceSourceControlTreeDirectoryKeys(sectionRoots, 'conflicts')
          : sectionRoots
      )
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
    // Selection/ranges must read injected submodule rows so rendered children remain selectable.
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
    displaySections,
    unfilteredDisplaySectionsById,
    filteredBranchEntries,
    visibleTreeRowsBySection,
    visibleListRowsBySection,
    visibleBranchTreeRows,
    visibleSelectionEntries
  }
}
