import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { basename } from '@/lib/path'
import type { SourceControlSectionArea } from '../../../../../../shared/source-control-section-order'
import type { SourceControlTreeNode } from '../../../../../../shared/source-control-tree'
import type { FlatEntry } from './use-selection'

export type SubmoduleSectionTreeNode = SourceControlTreeNode<
  GitStatusEntry,
  SourceControlSectionArea
>

/** Keep loading/empty/error placeholders distinct from real nodes so they cannot enter selection or bulk path collection. */
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

/** Expand dirtiness into inner status and moved gitlinks into commit diffs; already-inner rows never recurse. */
export function isExpandableSubmoduleEntry(entry: GitStatusEntry): boolean {
  const submodule = entry.submodule
  if (!submodule || entry.submoduleRoot) {
    return false
  }
  return submodule.commitChanged || submodule.trackedChanges || submodule.untrackedChanges
}

/** Stamp inner paths/read-only ownership; staged gitlinks force staged diffs, while worktree rows retain inner areas. */
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

export type RenderableSubmoduleListItem =
  | { type: 'entry'; entry: GitStatusEntry }
  | SubmodulePlaceholderNode

/** Inject lazy children into flat entries, mirroring tree-row expansion. */
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

/** Select from rendered injected rows so expanded children remain selectable; exclude placeholders. */
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

/** Expand only requested submodules so parent status polling never recurses. */
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
