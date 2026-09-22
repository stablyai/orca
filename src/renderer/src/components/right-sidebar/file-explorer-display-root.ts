import { translate } from '@/i18n/i18n'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
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
          label: translate('fileExplorer.root.full', 'Full repo root')
        },
        ...dirs.map((dir) => ({ value: dir, label: dir }))
      ]
    : null
}

/** Honors a valid saved choice; otherwise defaults to the first sparse directory or the full-root sentinel. */
export function resolveExplorerDisplayRootChoice(
  options: ExplorerRootOption[] | null,
  saved?: string
): string {
  return options?.some((option) => option.value === saved)
    ? saved!
    : (options?.[1]?.value ?? FILE_EXPLORER_FULL_ROOT)
}

/** Resolves a display choice against the actual workspace root; the full-root sentinel leaves that root intact. */
export function getExplorerDisplayRootPath(
  worktreePath: string | null,
  choice: string
): string | null {
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

/** Includes the displayed root for loading and refresh without persisting it as a user-expanded folder. */
export function getExplorerEffectiveExpanded(
  expanded: Set<string>,
  displayRootPath: string | null
): Set<string> {
  return displayRootPath && !expanded.has(displayRootPath)
    ? new Set([...expanded, displayRootPath])
    : expanded
}
