import { normalizeRelativePath } from '@/lib/path'
import type { GitStatusEntry, GitStagingArea } from '../../../../shared/types'
import { splitPathSegments } from './path-tree'
import { compareGitStatusEntries } from './source-control-status-sort'

export type SourceControlTreeArea = Extract<GitStagingArea, 'unstaged' | 'staged' | 'untracked'>
// Why: committed branch rows share the same path tree but do not carry
// uncommitted status metadata, so the tree builder stays entry-shape generic.
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
  return a.path.localeCompare(b.path, undefined, { numeric: true })
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

  directories.sort((a, b) => a.name.localeCompare(b.name))
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
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]
      const path = segments.slice(0, index + 1).join('/')
      let dir = parent.directoryChildren.get(name)
      if (!dir) {
        dir = makeDirectoryNode<Entry, Area>(area, path, name, index)
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
  // Why: uncommitted trees must preserve the conflict-first ordering used by
  // the flat Source Control list; branch trees can sort by path.
  return buildSourceControlTree(area, entries, compareGitStatusEntries)
}

export function flattenSourceControlTree<Entry extends SourceControlTreeEntry, Area extends string>(
  nodes: SourceControlTreeNode<Entry, Area>[],
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

    // Why: Source Control trees often contain path-only folder chains from a
    // small changed-file subset. Compressing them matches VS Code and keeps
    // branch change trees readable without changing the underlying file set.
    return {
      ...compacted,
      name: names.join('/'),
      depth,
      children: compacted.children.map((child) => compactNode(child, depth + 1))
    }
  }

  return nodes.map((node) => compactNode(node, 0))
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
