import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlSectionArea } from '../../../../../../shared/source-control/listing/source-control-section-order'
import {
  buildGitStatusSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeNode
} from '../../../../../../shared/source-control/listing/source-control-tree'
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
  expansionKey: string
  refreshing?: boolean
  depth: number
  state: 'loading' | 'empty' | 'error' | 'truncated'
  message?: string
}

export type RenderableSourceControlNode = SubmoduleSectionTreeNode | SubmodulePlaceholderNode

export type SubmoduleStatusState =
  | { status: 'loading' }
  | {
      status: 'loaded'
      entries: GitStatusEntry[]
      didHitLimit?: boolean
      error?: string
      refreshing?: boolean
    }
  | { status: 'error'; error: string; refreshing?: boolean }

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
): SubmoduleSectionTreeNode[] {
  const submodulePath = parent.entry.path
  const stampNode = (node: SubmoduleSectionTreeNode): SubmoduleSectionTreeNode => {
    const depth = parent.depth + 1 + node.depth
    if (node.type === 'file') {
      const entry = buildSubmoduleChildEntry(submodulePath, node.entry, parent.entry.area)
      return {
        ...node,
        key: `${entry.area}::${entry.path}`,
        path: entry.path,
        entry,
        area: entry.area,
        depth
      }
    }
    const path = `${submodulePath}/${node.path}`
    return {
      ...node,
      key: `dir::${parent.area}::${path}`,
      path,
      depth,
      children: node.children.map(stampNode)
    }
  }
  return compactSourceControlTree(buildGitStatusSourceControlTree(parent.area, innerEntries)).map(
    stampNode
  )
}

function buildSubmodulePlaceholders(
  entry: GitStatusEntry,
  state: SubmoduleStatusState | undefined,
  depth: number,
  loadingMessage: string,
  emptyMessage: string
): SubmodulePlaceholderNode[] {
  const placeholder = (
    kind: SubmodulePlaceholderNode['state'],
    message?: string
  ): SubmodulePlaceholderNode => ({
    type: 'submodule-placeholder',
    key: `submodule-${kind}::${entry.area}::${entry.path}`,
    submodulePath: entry.path,
    expansionKey: getSubmoduleExpansionKey(entry),
    depth,
    state: kind,
    message,
    ...(state && state.status !== 'loading' ? { refreshing: state.refreshing } : {})
  })
  if (!state || state.status === 'loading') {
    return [placeholder('loading', loadingMessage)]
  }
  if (state.error !== undefined) {
    return [placeholder('error', state.error)]
  }
  return state.status === 'loaded' && state.entries.length === 0
    ? [placeholder('empty', emptyMessage)]
    : []
}

function buildSubmoduleTruncationPlaceholder(
  entry: GitStatusEntry,
  depth: number
): SubmodulePlaceholderNode {
  return {
    type: 'submodule-placeholder',
    key: `submodule-truncated::${entry.area}::${entry.path}`,
    submodulePath: entry.path,
    expansionKey: getSubmoduleExpansionKey(entry),
    depth,
    state: 'truncated'
  }
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
    const state = submoduleStatusByKey[expansionKey]
    result.push(...buildSubmodulePlaceholders(entry, state, 1, loadingMessage, emptyMessage))
    if (state?.status !== 'loaded') {
      continue
    }
    for (const innerEntry of state.entries) {
      result.push({
        type: 'entry',
        entry: buildSubmoduleChildEntry(entry.path, innerEntry, entry.area)
      })
    }
    if (state.didHitLimit) {
      result.push(buildSubmoduleTruncationPlaceholder(entry, 1))
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
  emptyMessage: string,
  collapsedTreeDirs: ReadonlySet<string> = new Set()
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
    const state = submoduleStatusByKey[getSubmoduleExpansionKey(node.entry)]
    result.push(
      ...buildSubmodulePlaceholders(node.entry, state, node.depth + 1, loadingMessage, emptyMessage)
    )
    if (state?.status !== 'loaded') {
      continue
    }
    result.push(
      ...flattenSourceControlTree(buildSubmoduleChildNodes(node, state.entries), collapsedTreeDirs)
    )
    if (state.didHitLimit) {
      result.push(buildSubmoduleTruncationPlaceholder(node.entry, node.depth + 1))
    }
  }
  return result
}
