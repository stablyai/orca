import { normalizeRelativePath } from '@/lib/path'
import type { GitStagingArea, GitStatusEntry } from '../../../../shared/git-status-types'
import { compareFileNames } from '../../../../shared/file-name-sort'
import { splitPathSegments } from './path-tree'
import { compareGitStatusEntries } from './source-control-status-sort'

export type SourceControlTreeArea = Extract<GitStagingArea, 'unstaged' | 'staged' | 'untracked'>
// Keep entry shapes generic because committed branch rows lack uncommitted status metadata.
export type SourceControlTreeEntry = {
  path: string
}

export type SourceControlTreeFileNode<
  Entry extends SourceControlTreeEntry = GitStatusEntry,
  Area extends string = SourceControlTreeArea
> = {
  type: 'file'
  key: string
  name: string
  path: string
  entry: Entry
  area: Area
  depth: number
}

export type SourceControlTreeDirectoryNode<
  Entry extends SourceControlTreeEntry = GitStatusEntry,
  Area extends string = SourceControlTreeArea
> = {
  type: 'directory'
  key: string
  name: string
  path: string
  area: Area
  depth: number
  fileCount: number
  children: SourceControlTreeNode<Entry, Area>[]
}

export type SourceControlTreeNode<
  Entry extends SourceControlTreeEntry = GitStatusEntry,
  Area extends string = SourceControlTreeArea
> = SourceControlTreeFileNode<Entry, Area> | SourceControlTreeDirectoryNode<Entry, Area>

type MutableDirectoryNode<Entry extends SourceControlTreeEntry, Area extends string> = Omit<
  SourceControlTreeDirectoryNode<Entry, Area>,
  'children'
> & {
  children: SourceControlTreeNode<Entry, Area>[]
  directoryChildren: Map<string, MutableDirectoryNode<Entry, Area>>
}

function compareTreeEntriesByPath(a: SourceControlTreeEntry, b: SourceControlTreeEntry): number {
  return compareFileNames(a.path, b.path)
}

function makeDirectoryNode<Entry extends SourceControlTreeEntry, Area extends string>(
  area: Area,
  path: string,
  name: string,
  depth: number
): MutableDirectoryNode<Entry, Area> {
  return {
    type: 'directory',
    key: `dir::${area}::${path}`,
    name,
    path,
    area,
    depth,
    fileCount: 0,
    children: [],
    directoryChildren: new Map()
  }
}

function finalizeDirectoryNode<Entry extends SourceControlTreeEntry, Area extends string>(
  node: MutableDirectoryNode<Entry, Area>,
  compareEntries: (a: Entry, b: Entry) => number
): SourceControlTreeDirectoryNode<Entry, Area> {
  const directories: SourceControlTreeDirectoryNode<Entry, Area>[] = []
  const files: SourceControlTreeFileNode<Entry, Area>[] = []

  for (const child of node.children) {
    if (child.type === 'directory') {
      directories.push(
        finalizeDirectoryNode(child as MutableDirectoryNode<Entry, Area>, compareEntries)
      )
    } else {
      files.push(child)
    }
  }

  // Use the same numeric ordering for directories and file rows.
  directories.sort((a, b) => compareFileNames(a.name, b.name))
  files.sort((a, b) => compareEntries(a.entry, b.entry))
  const fileCount =
    files.length + directories.reduce((count, directory) => count + directory.fileCount, 0)

  return {
    type: 'directory',
    key: node.key,
    name: node.name,
    path: node.path,
    area: node.area,
    depth: node.depth,
    fileCount,
    children: [...directories, ...files]
  }
}

export function buildSourceControlTree<
  Entry extends SourceControlTreeEntry = GitStatusEntry,
  Area extends string = SourceControlTreeArea
>(
  area: Area,
  entries: Entry[],
  compareEntries: (a: Entry, b: Entry) => number = compareTreeEntriesByPath
): SourceControlTreeNode<Entry, Area>[] {
  const root = makeDirectoryNode<Entry, Area>(area, '', '', -1)

  for (const entry of entries) {
    const normalizedPath = normalizeRelativePath(entry.path)
    const segments = splitPathSegments(normalizedPath)
    if (segments.length === 0) {
      continue
    }

    let parent = root
    // Build ancestor strings only on misses; slice/join per segment was quadratic in depth during every filter keystroke.
    let ancestorPath = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]
      ancestorPath = ancestorPath ? `${ancestorPath}/${name}` : name
      let dir = parent.directoryChildren.get(name)
      if (!dir) {
        dir = makeDirectoryNode<Entry, Area>(area, ancestorPath, name, index)
        parent.directoryChildren.set(name, dir)
        parent.children.push(dir)
      }
      parent = dir
    }

    const fileName = segments.at(-1)!
    parent.children.push({
      type: 'file',
      key: `${area}::${entry.path}`,
      name: fileName,
      path: normalizedPath,
      entry,
      area,
      depth: segments.length - 1
    })
  }

  return finalizeDirectoryNode(root, compareEntries).children
}

export function buildGitStatusSourceControlTree(
  area: SourceControlTreeArea,
  entries: GitStatusEntry[]
): SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea>[] {
  // Preserve flat-list conflict-first ordering for uncommitted trees; branch trees may sort by path.
  return buildSourceControlTree(area, entries, compareGitStatusEntries)
}

export function flattenSourceControlTree<Entry extends SourceControlTreeEntry, Area extends string>(
  nodes: readonly SourceControlTreeNode<Entry, Area>[],
  collapsedDirectoryKeys: ReadonlySet<string>
): SourceControlTreeNode<Entry, Area>[] {
  const result: SourceControlTreeNode<Entry, Area>[] = []

  const visit = (node: SourceControlTreeNode<Entry, Area>): void => {
    result.push(node)
    if (node.type === 'directory' && !collapsedDirectoryKeys.has(node.key)) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  for (const node of nodes) {
    visit(node)
  }

  return result
}

export function compactSourceControlTree<Entry extends SourceControlTreeEntry, Area extends string>(
  nodes: SourceControlTreeNode<Entry, Area>[]
): SourceControlTreeNode<Entry, Area>[] {
  const compactNode = (
    node: SourceControlTreeNode<Entry, Area>,
    depth: number
  ): SourceControlTreeNode<Entry, Area> => {
    if (node.type === 'file') {
      return { ...node, depth }
    }

    const names = [node.name]
    let compacted = node
    while (compacted.children.length === 1 && compacted.children[0]?.type === 'directory') {
      compacted = compacted.children[0]
      names.push(compacted.name)
    }

    // Compact single-folder chains in sparse changed-file trees without changing file identity.
    return {
      ...compacted,
      name: names.join('/'),
      depth,
      children: compacted.children.map((child) => compactNode(child, depth + 1))
    }
  }

  return nodes.map((node) => compactNode(node, 0))
}

export function namespaceSourceControlTreeDirectoryKeys<
  Entry extends SourceControlTreeEntry,
  Area extends string
>(
  nodes: SourceControlTreeNode<Entry, Area>[],
  namespace: string
): SourceControlTreeNode<Entry, Area>[] {
  const namespaceNode = (
    node: SourceControlTreeNode<Entry, Area>
  ): SourceControlTreeNode<Entry, Area> => {
    if (node.type === 'file') {
      return node
    }

    // Pinned conflicts share Git areas but need section-local collapse keys.
    return {
      ...node,
      key: `dir::${namespace}::${node.path}`,
      children: node.children.map(namespaceNode)
    }
  }

  return nodes.map(namespaceNode)
}

export function applyGitStatusEntryAreasToSourceControlTree(
  nodes: SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea>[]
): SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea>[] {
  const applyEntryArea = (
    node: SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea>
  ): SourceControlTreeNode<GitStatusEntry, SourceControlTreeArea> => {
    if (node.type === 'file') {
      return {
        ...node,
        key: `${node.entry.area}::${node.entry.path}`,
        area: node.entry.area
      }
    }

    return {
      ...node,
      children: node.children.map(applyEntryArea)
    }
  }

  return nodes.map(applyEntryArea)
}

export function collectSourceControlTreeFileEntries<
  Entry extends SourceControlTreeEntry,
  Area extends string
>(node: SourceControlTreeNode<Entry, Area>): Entry[] {
  if (node.type === 'file') {
    return [node.entry]
  }

  const entries: Entry[] = []
  const collect = (child: SourceControlTreeNode<Entry, Area>): void => {
    if (child.type === 'file') {
      entries.push(child.entry)
      return
    }
    for (const grandchild of child.children) {
      collect(grandchild)
    }
  }

  for (const child of node.children) {
    collect(child)
  }
  return entries
}
