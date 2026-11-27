import {
  isCaseInsensitiveRuntimeRoot,
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { WATCHER_IGNORE_DIRS } from '../../../../../../shared/file-watch/watcher-ignore-dirs'

// Why the Library names: a macOS watch rooted above ~/Library skips it and its app containers (macos-protected-watch-exclusions).
const IGNORED_WATCH_DIRS = new Set([
  ...WATCHER_IGNORE_DIRS,
  'Library',
  'Containers',
  'Group Containers'
])
const IGNORED_WATCH_DIRS_FOLDED = new Set([...IGNORED_WATCH_DIRS].map((name) => name.toLowerCase()))

/**
 * Folders from `from` down to `path`, outermost first and in `path`'s own spelling, whose recursive watch reports
 * changes in `path`. Null when only a watch on `path` itself can: outside `from`, WSL, or a spelling we can't split.
 * `from` must have no symlink between it and `path` (the deepest link, or a folder at or below it).
 */
export function coveringAncestors(path: string, from: string): string[] | null {
  const windowsSyntax = isWindowsAbsolutePathLike(path)
  // Why by syntax: a backslash is a filename character on POSIX.
  const trimmed = path.replace(windowsSyntax ? /[\\/]+$/ : /\/+$/, '')
  const relative = relativePathInsideRoot(from, trimmed)
  // Why the slash form: a Windows suffix comes back slash-separated while tab folders keep backslashes.
  const suffix = relative === null ? '' : trimmed.slice(trimmed.length - relative.length)
  // Why WSL: its watcher polls two levels below the root instead of watching recursively.
  if (
    relative === null ||
    isWslUncPath(trimmed) ||
    (windowsSyntax ? suffix.replace(/\\/g, '/') : suffix) !== relative
  ) {
    return null
  }
  // Why the folder's own spelling: ancestors are looked up as open tab folder keys, which use it.
  const separator = windowsSyntax ? /[\\/]/ : /\//
  const fromEnd = trimmed.length - relative.length
  const ancestors = [relative === '' ? trimmed : trimmed.slice(0, fromEnd - 1)]
  const names: string[] = []
  let start = fromEnd
  for (let index = fromEnd; relative !== '' && index <= trimmed.length; index += 1) {
    if (index === trimmed.length || separator.test(trimmed[index])) {
      names.push(trimmed.slice(start, index))
      ancestors.push(trimmed.slice(0, index))
      start = index + 1
    }
  }
  // Why fold only there: the watcher's filter is case-sensitive, but a Windows tab may spell an ignored folder in another case.
  const foldCase = isCaseInsensitiveRuntimeRoot(from)
  const lastIgnored = names.findLastIndex((name) =>
    foldCase ? IGNORED_WATCH_DIRS_FOLDED.has(name.toLowerCase()) : IGNORED_WATCH_DIRS.has(name)
  )
  // Why past the last ignored folder: the watcher skips it, so a watch above it doesn't see this folder.
  return ancestors.slice(lastIgnored + 1)
}
