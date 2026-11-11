import { useMemo } from 'react'
import {
  useSourceControlReview,
  useRevalidateSourceControlReviews
} from './use-source-control-review'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import { compareFileNames } from '../../../../../../shared/file-listing/file-name-sort'
import { filterSourceControlPathEntries, getSourceControlFileFilterState } from './file-filter'
import {
  applyGitStatusEntryAreasToSourceControlTree,
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  namespaceSourceControlTreeDirectoryKeys,
  type SourceControlTreeNode
} from '../../../../../../shared/source-control/listing/source-control-tree'
import {
  buildSourceControlDisplaySections,
  groupSourceControlEntries,
  type SourceControlDisplaySectionId,
  type SourceControlDisplaySectionArea
} from '../../../../../../shared/source-control/listing/source-control-section-order'
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
import { getSubmoduleEmptyLabel, getSubmoduleLoadingLabel } from './row-layout'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useTranslate } from '@/i18n/use-translate'
import { entryReviewSource } from '@/lib/editor/diff-reviewed-files'

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
}) {
  const t = useTranslate()
  const review = useSourceControlReview(activeWorktreeId, worktreePath)
  useRevalidateSourceControlReviews(review, entries, branchEntries)
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
            .map((entry) => ({
              entry,
              viewed:
                sourceControlViewMode === 'list' && review.isViewed(entry, entryReviewSource(entry))
            }))
            .sort((a, b) => Number(a.viewed) - Number(b.viewed))
            .map(({ entry }) => entry)
        }))
        .filter((section) => section.items.length > 0),
    [fileFilterState, unfilteredDisplaySections, review, sourceControlViewMode]
  )
  const unfilteredDisplaySectionsById = useMemo(
    () => new Map(unfilteredDisplaySections.map((section) => [section.id, section])),
    [unfilteredDisplaySections]
  )

  // Stable sorting commutes with filtering, including ties; sort once to keep collator work off keystrokes.
  const sortedBranchEntries = useMemo(
    () =>
      branchEntries
        .map((entry) => ({
          entry,
          viewed: sourceControlViewMode === 'list' && review.isViewed(entry, 'branch')
        }))
        .sort(
          (a, b) =>
            Number(a.viewed) - Number(b.viewed) || compareFileNames(a.entry.path, b.entry.path)
        )
        .map(({ entry }) => entry),
    [branchEntries, review, sourceControlViewMode]
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

  const languageRevision = useUiLanguageRevision()
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
        getSubmoduleLoadingLabel(t),
        getSubmoduleEmptyLabel(t)
      )
    }
    return rows
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- placeholder labels read the UI language.
  }, [
    collapsedTreeDirs,
    displaySections,
    treeRootsBySection,
    expandedSubmoduleKeys,
    sourceControlViewMode,
    submoduleStatusByKey,
    languageRevision,
    t
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
        getSubmoduleLoadingLabel(t),
        getSubmoduleEmptyLabel(t)
      )
    }
    return rows
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- placeholder labels read the UI language.
  }, [
    displaySections,
    expandedSubmoduleKeys,
    sourceControlViewMode,
    submoduleStatusByKey,
    languageRevision,
    t
  ])

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
  const reviewSelectionEntries = useMemo(
    () =>
      displaySections.flatMap((section) =>
        sourceControlViewMode === 'tree'
          ? flattenSourceControlTree(treeRootsBySection[section.id] ?? [], new Set()).flatMap(
              (node) =>
                node.type === 'file'
                  ? [{ key: node.key, entry: node.entry, area: node.entry.area }]
                  : []
            )
          : section.items.map((entry) => ({
              key: `${entry.area}::${entry.path}`,
              entry,
              area: entry.area
            }))
      ),
    [displaySections, sourceControlViewMode, treeRootsBySection]
  )
  const reviewBranchEntries = useMemo(
    () =>
      sourceControlViewMode === 'tree'
        ? flattenSourceControlTree(branchTreeRoots, new Set()).flatMap((node) =>
            node.type === 'file' ? [node.entry] : []
          )
        : filteredBranchEntries,
    [sourceControlViewMode, branchTreeRoots, filteredBranchEntries]
  )
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
    visibleSelectionEntries,
    reviewSelectionEntries,
    reviewBranchEntries
  }
}

export type SourceControlFileProjection = ReturnType<typeof useSourceControlFileProjection>
