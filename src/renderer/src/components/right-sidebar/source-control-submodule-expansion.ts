import type { GitStatusEntry } from '../../../../shared/types'
import { basename } from '@/lib/path'
import type { SourceControlSectionArea } from './source-control-section-order'
import type { SourceControlTreeNode } from './source-control-tree'
import type { FlatEntry } from './useSourceControlSelection'

export type SubmoduleSectionTreeNode = SourceControlTreeNode<
  GitStatusEntry,
  SourceControlSectionArea
>

/**
 * Loading/empty/error placeholder shown beneath an expanded submodule while its
 * inner status is fetched on demand. Kept separate from real tree nodes so it
 * never leaks into selection or bulk path collection.
 */
export type SubmodulePlaceholderNode = {
  type: 'submodule-placeholder'
  key: string
  submodulePath: string
  depth: number
  state: 'loading' | 'empty' | 'error' | 'truncated'
  message?: string
}

export type RenderableSourceControlNode = SubmoduleSectionTreeNode | SubmodulePlaceholderNode

export type SubmoduleStatusState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: GitStatusEntry[]; didHitLimit?: boolean }
  | { status: 'error'; error: string }

export function getSubmoduleExpansionKey(entry: Pick<GitStatusEntry, 'area' | 'path'>): string {
  return `${entry.area}::${entry.path}`
}

export function parseSubmoduleExpansionKey(
  key: string
): { area: GitStatusEntry['area']; path: string } | null {
  const separatorIndex = key.indexOf('::')
  if (separatorIndex <= 0) {
    return null
  }
  const area = key.slice(0, separatorIndex)
  if (area !== 'staged' && area !== 'unstaged' && area !== 'untracked') {
    return null
  }
  const path = key.slice(separatorIndex + 2)
  return path ? { area, path } : null
}

/**
 * Any changed submodule is shown as an expandable row: worktree dirtiness
 * (tracked/untracked) expands to the inner `git status`, and a moved commit
 * pointer expands to the files changed between the recorded and checked-out
 * commits. Already-inner rows (`submoduleRoot` set) never expand again.
 */
export function isExpandableSubmoduleEntry(entry: GitStatusEntry): boolean {
  const submodule = entry.submodule
  if (!submodule || entry.submoduleRoot) {
    return false
  }
  return submodule.commitChanged || submodule.trackedChanges || submodule.untrackedChanges
}

/**
 * Build the read-only inner entry for a submodule child row. The inner path is
 * relative to the submodule root, so it is prefixed with the submodule path
 * (drives diff routing) and stamped with `submoduleRoot` (drives read-only
 * gating). Staged parent gitlink rows force staged children because their
 * expansion represents HEAD->index, but worktree-only rows keep the inner
 * entry's own area so staged-only submodule changes don't open empty diffs.
 */
export function buildSubmoduleChildEntry(
  submodulePath: string,
  innerEntry: GitStatusEntry,
  parentArea: GitStatusEntry['area'] = innerEntry.area
): GitStatusEntry {
  const area = parentArea === 'staged' ? 'staged' : innerEntry.area
  return {
    ...innerEntry,
    path: `${submodulePath}/${innerEntry.path}`,
    ...(innerEntry.oldPath ? { oldPath: `${submodulePath}/${innerEntry.oldPath}` } : {}),
    area,
    submoduleRoot: submodulePath
  }
}

/**
 * Build the child file rows for an expanded submodule (tree view).
 */
export function buildSubmoduleChildNodes(
  parent: SubmoduleSectionTreeNode & { type: 'file' },
  innerEntries: GitStatusEntry[]
): (SubmoduleSectionTreeNode & { type: 'file' })[] {
  const submodulePath = parent.entry.path
  return innerEntries.map((innerEntry) => {
    const childEntry = buildSubmoduleChildEntry(submodulePath, innerEntry, parent.entry.area)
    return {
      type: 'file',
      key: `${childEntry.area}::${childEntry.path}`,
      name: basename(childEntry.path),
      path: childEntry.path,
      entry: childEntry,
      area: childEntry.area,
      depth: parent.depth + 1
    }
  })
}

/**
 * Flat-list (non-tree) variant of an expanded source-control row: either a real
 * status entry or a submodule placeholder. Used by the list view, which renders
 * raw entries instead of tree nodes.
 */
export type RenderableSubmoduleListItem =
  | { type: 'entry'; entry: GitStatusEntry }
  | SubmodulePlaceholderNode

/**
 * Splice lazily-loaded submodule children into a flat list of status entries
 * (list view). Mirrors injectExpandedSubmoduleRows but operates on entries.
 */
export function injectExpandedSubmoduleEntries(
  entries: readonly GitStatusEntry[],
  expandedSubmoduleKeys: ReadonlySet<string>,
  submoduleStatusByKey: Readonly<Record<string, SubmoduleStatusState>>,
  loadingMessage: string,
  emptyMessage: string
): RenderableSubmoduleListItem[] {
  const result: RenderableSubmoduleListItem[] = []
  for (const entry of entries) {
    result.push({ type: 'entry', entry })
    const expansionKey = getSubmoduleExpansionKey(entry)
    if (!isExpandableSubmoduleEntry(entry) || !expandedSubmoduleKeys.has(expansionKey)) {
      continue
    }
    const submodulePath = entry.path
    const state = submoduleStatusByKey[expansionKey]
    if (!state || state.status === 'loading') {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-loading::${entry.area}::${submodulePath}`,
        submodulePath,
        depth: 1,
        state: 'loading',
        message: loadingMessage
      })
      continue
    }
    if (state.status === 'error') {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-error::${entry.area}::${submodulePath}`,
        submodulePath,
        depth: 1,
        state: 'error',
        message: state.error
      })
      continue
    }
    if (state.entries.length === 0) {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-empty::${entry.area}::${submodulePath}`,
        submodulePath,
        depth: 1,
        state: 'empty',
        message: emptyMessage
      })
      continue
    }
    for (const innerEntry of state.entries) {
      result.push({
        type: 'entry',
        entry: buildSubmoduleChildEntry(submodulePath, innerEntry, entry.area)
      })
    }
    if (state.didHitLimit) {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-truncated::${entry.area}::${submodulePath}`,
        submodulePath,
        depth: 1,
        state: 'truncated'
      })
    }
  }
  return result
}

/**
 * Map injected list rows to selection entries. List-view selection/range/open-key
 * bookkeeping must read the same submodule-injected rows it renders; otherwise an
 * expanded submodule's child files render with handlers but stay unselectable.
 * Placeholders are skipped because they are not selectable.
 */
export function collectListSelectionEntries(
  rows: readonly RenderableSubmoduleListItem[]
): FlatEntry[] {
  const result: FlatEntry[] = []
  for (const row of rows) {
    if (row.type === 'entry') {
      result.push({
        key: `${row.entry.area}::${row.entry.path}`,
        entry: row.entry,
        area: row.entry.area
      })
    }
  }
  return result
}

/**
 * Splice lazily-loaded submodule children into a flattened tree row list. Only
 * expanded submodules are touched; everything else passes through untouched so
 * the status poll stays free of submodule recursion.
 */
export function injectExpandedSubmoduleRows(
  nodes: SubmoduleSectionTreeNode[],
  expandedSubmoduleKeys: ReadonlySet<string>,
  submoduleStatusByKey: Readonly<Record<string, SubmoduleStatusState>>,
  loadingMessage: string,
  emptyMessage: string
): RenderableSourceControlNode[] {
  const result: RenderableSourceControlNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (
      node.type !== 'file' ||
      !isExpandableSubmoduleEntry(node.entry) ||
      !expandedSubmoduleKeys.has(getSubmoduleExpansionKey(node.entry))
    ) {
      continue
    }
    const submodulePath = node.entry.path
    const state = submoduleStatusByKey[getSubmoduleExpansionKey(node.entry)]
    if (!state || state.status === 'loading') {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-loading::${node.area}::${submodulePath}`,
        submodulePath,
        depth: node.depth + 1,
        state: 'loading',
        message: loadingMessage
      })
      continue
    }
    if (state.status === 'error') {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-error::${node.area}::${submodulePath}`,
        submodulePath,
        depth: node.depth + 1,
        state: 'error',
        message: state.error
      })
      continue
    }
    if (state.entries.length === 0) {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-empty::${node.area}::${submodulePath}`,
        submodulePath,
        depth: node.depth + 1,
        state: 'empty',
        message: emptyMessage
      })
      continue
    }
    for (const childNode of buildSubmoduleChildNodes(node, state.entries)) {
      result.push(childNode)
    }
    if (state.didHitLimit) {
      result.push({
        type: 'submodule-placeholder',
        key: `submodule-truncated::${node.area}::${submodulePath}`,
        submodulePath,
        depth: node.depth + 1,
        state: 'truncated'
      })
    }
  }
  return result
}
