import type { GitHubPRFile } from '../../../shared/types'

export type DiffTreeLeaf = {
  kind: 'file'
  file: GitHubPRFile
  /** Basename shown in the tree row. */
  name: string
}

export type DiffTreeDir = {
  kind: 'dir'
  /** Display label — may be a compacted "a/b/c" segment for single-child chains. */
  name: string
  /** Original path segments (joined) that this node covers. */
  path: string
  children: DiffTreeNode[]
}

export type DiffTreeNode = DiffTreeLeaf | DiffTreeDir

/** Intermediate mutable structure used during tree construction. */
type MutableDir = {
  dirs: Map<string, MutableDir>
  files: GitHubPRFile[]
}

function insertFile(root: MutableDir, segments: string[], file: GitHubPRFile): void {
  if (segments.length === 1) {
    root.files.push(file)
    return
  }
  const [head, ...rest] = segments
  // head is always defined because segments.length >= 2 here
  const segment = head!
  if (!root.dirs.has(segment)) {
    root.dirs.set(segment, { dirs: new Map(), files: [] })
  }
  insertFile(root.dirs.get(segment)!, rest, file)
}

/**
 * Compact "elevator" nodes: a directory with exactly one child directory and
 * no files is merged with its sole child (similar to VS Code's compact folders).
 */
function compact(node: MutableDir, prefix: string): DiffTreeNode[] {
  const children: DiffTreeNode[] = []

  for (const file of node.files) {
    const segments = file.path.split(/[\\/]+/).filter(Boolean)
    children.push({ kind: 'file', file, name: segments.at(-1) ?? file.path })
  }

  for (const [name, child] of node.dirs) {
    const dirPath = prefix ? `${prefix}/${name}` : name
    children.push(buildDirNode(name, dirPath, child))
  }

  // Sort: dirs first, then files, each group alpha-sorted
  children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'dir' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return children
}

function buildDirNode(name: string, path: string, node: MutableDir): DiffTreeDir {
  // Compact: merge single-child-dir chains into one label
  let label = name
  let current = node
  let currentPath = path

  while (current.files.length === 0 && current.dirs.size === 1) {
    const [[childName, childNode]] = current.dirs
    label = `${label}/${childName}`
    currentPath = `${currentPath}/${childName}`
    current = childNode
  }

  return {
    kind: 'dir',
    name: label,
    path: currentPath,
    children: compact(current, currentPath)
  }
}

/** Builds a sorted, compacted directory tree from a flat list of PR files. */
export function buildDiffTree(files: GitHubPRFile[]): DiffTreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] }
  for (const file of files) {
    const segments = file.path.split(/[\\/]+/).filter(Boolean)
    insertFile(root, segments, file)
  }
  return compact(root, '')
}
