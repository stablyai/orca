import { joinPath, normalizeRelativePath } from '@/lib/path'
import type { TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { isDotfileRelativePath } from './file-explorer-entries'
import { splitPathSegments } from './path-tree'
import { isPathIgnored } from './status-display'

export type FileExplorerNameFilterProjectionSource = {
  query: string
  relativePaths: readonly string[] | null
}

export function getFileExplorerNameFilterTokens(query: string | undefined): string[] {
  return (query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

function relativePathMatchesNameFilter(relativePath: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return true
  }
  const haystack = normalizeRelativePath(relativePath).toLocaleLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

export function getFileExplorerNameFilterIgnoredQueryRelativePaths(
  source: FileExplorerNameFilterProjectionSource,
  showDotfiles: boolean
): string[] {
  if (source.relativePaths === null) {
    return []
  }
  const tokens = getFileExplorerNameFilterTokens(source.query)
  return source.relativePaths
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter(
      (relativePath) =>
        Boolean(relativePath) &&
        (showDotfiles || !isDotfileRelativePath(relativePath)) &&
        relativePathMatchesNameFilter(relativePath, tokens)
    )
}

type SyntheticTreeEntry = {
  node: TreeNode
  children: Map<string, SyntheticTreeEntry>
}

function createSyntheticNode(
  worktreePath: string,
  relativePath: string,
  name: string,
  depth: number,
  isDirectory: boolean
): TreeNode {
  return {
    name,
    path: joinPath(worktreePath, relativePath),
    relativePath,
    isDirectory,
    depth
  }
}

export function createNameFilteredFileExplorerProjection({
  ignoredSet,
  nameFilter,
  showDotfiles,
  showGitIgnoredFiles,
  worktreePath
}: {
  ignoredSet: Set<string>
  nameFilter: FileExplorerNameFilterProjectionSource
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
  worktreePath: string
}): FileExplorerRowProjection {
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  const nameFilterTokens = getFileExplorerNameFilterTokens(nameFilter.query)
  if (nameFilterTokens.length === 0 || nameFilter.relativePaths === null) {
    // Why: empty queries use the normal explorer projection, and loading filters must not
    // fall back to a partial cached path list.
    return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  }

  const rootChildren = new Map<string, SyntheticTreeEntry>()
  for (const rawRelativePath of nameFilter.relativePaths) {
    const relativePath = normalizeRelativePath(rawRelativePath)
    if (!relativePath) {
      continue
    }
    if (!showDotfiles && isDotfileRelativePath(relativePath)) {
      continue
    }
    if (!showGitIgnoredFiles && isPathIgnored(ignoredSet, relativePath)) {
      continue
    }
    if (!relativePathMatchesNameFilter(relativePath, nameFilterTokens)) {
      continue
    }

    const segments = splitPathSegments(relativePath)
    let currentChildren = rootChildren
    let currentRelativePath = ''
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]
      currentRelativePath = currentRelativePath ? joinPath(currentRelativePath, name) : name
      const isDirectory = index < segments.length - 1
      let entry = currentChildren.get(name)
      if (!entry) {
        entry = {
          node: createSyntheticNode(worktreePath, currentRelativePath, name, index, isDirectory),
          children: new Map()
        }
        currentChildren.set(name, entry)
      } else if (isDirectory && !entry.node.isDirectory) {
        entry.node = { ...entry.node, isDirectory: true }
      }
      currentChildren = entry.children
    }
  }

  appendNameFilteredEntries(rootChildren.values(), visibleFlatRows, rowsByPath)
  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

function appendNameFilteredEntries(
  entries: Iterable<SyntheticTreeEntry>,
  visibleFlatRows: TreeNode[],
  rowsByPath: Map<string, TreeNode>
): void {
  const sortedEntries = Array.from(entries).sort((a, b) => {
    if (a.node.isDirectory !== b.node.isDirectory) {
      return a.node.isDirectory ? -1 : 1
    }
    return a.node.name.localeCompare(b.node.name)
  })
  for (const entry of sortedEntries) {
    visibleFlatRows.push(entry.node)
    rowsByPath.set(entry.node.path, entry.node)
    if (entry.children.size > 0) {
      appendNameFilteredEntries(entry.children.values(), visibleFlatRows, rowsByPath)
    }
  }
}

export function getFileExplorerNameFilterExpandedPaths(
  rowProjection: FileExplorerRowProjection,
  nameFilterQuery: string
): Set<string> {
  if (getFileExplorerNameFilterTokens(nameFilterQuery).length === 0) {
    return new Set()
  }

  const expandedPaths = new Set<string>()
  const count = rowProjection.getVisibleCount()
  for (let index = 0; index < count - 1; index += 1) {
    const row = rowProjection.getRowAtIndex(index)
    const nextRow = rowProjection.getRowAtIndex(index + 1)
    if (row?.isDirectory && nextRow && nextRow.depth > row.depth) {
      expandedPaths.add(row.path)
    }
  }
  return expandedPaths
}
