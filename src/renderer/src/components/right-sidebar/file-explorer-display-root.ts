import { translate } from '@/i18n/i18n'
import { dirname, getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { FILE_EXPLORER_FULL_ROOT } from '../../../../shared/file-explorer-display-root'
import { splitPathSegments } from './path-tree'

export { FILE_EXPLORER_FULL_ROOT }
export type ExplorerRootOption = { value: string; label: string }

/** Returns deduplicated safe sparse-directory choices plus full root, or null when scoping is unavailable. */
export function getExplorerDisplayRootOptions(
  worktree: {
    isSparse?: boolean
    sparseDirectories?: string[]
  } | null
): ExplorerRootOption[] | null {
  if (!worktree?.isSparse) {
    return null
  }
  const dirs = [
    ...new Set(
      (worktree.sparseDirectories ?? [])
        .filter(
          (dir) =>
            Boolean(dir) &&
            !/^[\\/]|^[A-Za-z]:/.test(dir) &&
            !splitPathSegments(dir).some((part) => part === '..' || part === '.')
        )
        .map((dir) => splitPathSegments(dir).join('/'))
    )
  ].filter(Boolean)
  return dirs.length
    ? [
        {
          value: FILE_EXPLORER_FULL_ROOT,
          label: translate('fileExplorer.root.full', 'Repository root')
        },
        ...dirs.map((dir) => ({ value: dir, label: dir }))
      ]
    : null
}

/** Focuses a sole sparse directory; multiple directories retain repository context unless explicitly scoped. */
export function resolveExplorerDisplayRootChoice(
  options: ExplorerRootOption[] | null,
  saved?: string
): string {
  return options?.some((option) => option.value === saved)
    ? saved!
    : options?.length === 2
      ? options[1].value
      : FILE_EXPLORER_FULL_ROOT
}

/** Resolves a display choice against the actual workspace root; the full-root sentinel leaves that root intact. */
export function getExplorerDisplayRootPath(
  worktreePath: string | null,
  choice: string,
  browsedRootPath?: string | null
): string | null {
  if (browsedRootPath) {
    return browsedRootPath
  }
  return worktreePath && choice !== FILE_EXPLORER_FULL_ROOT
    ? joinPath(worktreePath, choice)
    : worktreePath
}

/** Returns the ancestor depth to subtract from cached row indentation, without rebasing file identities. */
export function getExplorerDisplayDepth(
  worktreePath: string | null,
  displayRootPath: string | null
): number {
  const relative = displayRootPath ? getRelativePathInsideRoot(displayRootPath, worktreePath) : null
  return relative ? splitPathSegments(relative).length : 0
}

export function getExplorerDirectoryDepth(
  worktreePath: string | null,
  displayRootPath: string,
  dirPath: string
): number {
  const displayRootInsideWorkspace =
    getRelativePathInsideRoot(displayRootPath, worktreePath) !== null
  const workspaceRelative = displayRootInsideWorkspace
    ? getRelativePathInsideRoot(dirPath, worktreePath)
    : null
  const displayRelative = getRelativePathInsideRoot(dirPath, displayRootPath)
  const relativePath = workspaceRelative ?? displayRelative
  return relativePath ? splitPathSegments(relativePath).length - 1 : -1
}

/** Expanded folders a refresh reads after the displayed root, each with the depth it lists at. */
export function getExplorerRefreshDirs(
  worktreePath: string | null,
  displayRootPath: string,
  expanded: Iterable<string>
): { dirPath: string; depth: number }[] {
  // Why: '' is the root, already read; an expanded folder outside the displayed tree is not on screen.
  return Array.from(expanded)
    .filter((dirPath) => Boolean(getRelativePathInsideRoot(dirPath, displayRootPath)))
    .map((dirPath) => ({
      dirPath,
      depth: getExplorerDirectoryDepth(worktreePath, displayRootPath, dirPath)
    }))
}

export function isExplorerRootOutsideWorkspace(
  worktreePath: string | null,
  displayRootPath: string | null
): boolean {
  return Boolean(
    worktreePath &&
    displayRootPath &&
    getRelativePathInsideRoot(displayRootPath, worktreePath) === null
  )
}

/** The workspace whose file changes reach the tree: an outside ancestor still shows its folders. */
export function getExplorerWatchedWorkspacePath(
  worktreePath: string | null,
  displayRootPath: string | null
): string | null {
  return worktreePath &&
    displayRootPath &&
    isExplorerRootOutsideWorkspace(worktreePath, displayRootPath) &&
    getRelativePathInsideRoot(worktreePath, displayRootPath) === null
    ? null
    : worktreePath
}

export type ExplorerBreadcrumb = { label: string; path: string }

export function getExplorerBreadcrumbs(path: string): ExplorerBreadcrumb[] {
  if (isWindowsAbsolutePathLike(path)) {
    const separator = path.includes('\\') ? '\\' : '/'
    const normalized = path.replace(/[\\/]+/g, separator)
    const drive = normalized.match(/^[A-Za-z]:/)
    if (drive) {
      const root = `${drive[0]}${separator}`
      return buildBreadcrumbs(root, normalized.slice(root.length))
    }
    const parts = normalized
      .replace(/^[\\/]+/, '')
      .split(separator)
      .filter(Boolean)
    const rootParts = parts.slice(0, 2)
    const root = `${separator}${separator}${rootParts.join(separator)}`
    return buildBreadcrumbs(root, parts.slice(2).join(separator))
  }
  return buildBreadcrumbs('/', path)
}

function buildBreadcrumbs(root: string, remainder: string): ExplorerBreadcrumb[] {
  const breadcrumbs = [{ label: root, path: root }]
  let current = root
  // Why: the root's flavor decides the separators, so a POSIX name may still contain a backslash.
  for (const segment of splitPathSegments(remainder, root)) {
    current = joinPath(current, segment)
    breadcrumbs.push({ label: segment, path: current })
  }
  return breadcrumbs
}

// Why: deep directory trees push the active folder offscreen; collapsing intermediate segments preserves both root and current folder.
export function getCollapsedExplorerBreadcrumbs(
  breadcrumbs: readonly ExplorerBreadcrumb[],
  maxVisible = 3
): ExplorerBreadcrumb[] {
  if (breadcrumbs.length <= maxVisible) {
    return [...breadcrumbs]
  }
  const root = breadcrumbs[0]
  const trailing = breadcrumbs.slice(-1)
  return [root, { label: '…', path: breadcrumbs.at(-2)?.path ?? root.path }, ...trailing]
}

export function getExplorerParentPath(path: string): string {
  const breadcrumbs = getExplorerBreadcrumbs(path)
  return breadcrumbs.length > 1
    ? (breadcrumbs.at(-2)?.path ?? dirname(path))
    : (breadcrumbs[0]?.path ?? dirname(path))
}

/** Includes the displayed root for loading and refresh without persisting it as a user-expanded folder. */
export function getExplorerEffectiveExpanded(
  expanded: Set<string>,
  displayRootPath: string | null
): Set<string> {
  return displayRootPath && !expanded.has(displayRootPath)
    ? new Set([...expanded, displayRootPath])
    : expanded
}
