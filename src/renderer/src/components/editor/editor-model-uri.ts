import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

const FILE_SCHEME = /^file:/i
const OWNER_PREFIX = '/.orca-owner/'

/** Two FNV-1a lanes: a short, stable segment per owner, so different owners don't collide. */
function ownerSegment(ownerKey: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < ownerKey.length; index += 1) {
    const code = ownerKey.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

function withoutOwner(path: string): string {
  if (!path.startsWith(OWNER_PREFIX)) {
    return path
  }
  const rest = path.indexOf('/', OWNER_PREFIX.length)
  return rest === -1 ? path : path.slice(rest)
}

/**
 * The single filesystem-path -> Monaco model key function. Monaco keys its model registry by
 * `uri.toString()`, so creation, lookup and ownership comparison must all go through this.
 *
 * Why not `Uri.parse`: it reads `C:\src\a.ts` as scheme `c`, which fails the scheme gate in
 * `modelService._schemaShouldMaintainUndoRedoElements`, so closed-file undo is dropped for every
 * file on Windows. `Uri.file` always yields the `file:` scheme that gate allows, and the result
 * re-parses to itself, so a consumer that can only take a string (the `path` prop of
 * `@monaco-editor/react`, which calls `Uri.parse` internally) lands on the same key.
 */
export function toEditorModelUri(filePath: string, ownerKey = ''): string {
  const parsed = FILE_SCHEME.test(filePath) ? URI.parse(filePath) : URI.file(filePath)
  const wsl = parseWslUncPath(parsed.fsPath)
  // Why: `\\wsl$` and `\\wsl.localhost` front one distro, whose name Windows folds.
  const base = URI.file(
    wsl ? `//wsl.localhost/${wsl.distro.toLowerCase()}${wsl.linuxPath}` : parsed.fsPath
  )
  if (!ownerKey) {
    // An existing model key passes through unchanged: its owner folder is part of its path.
    return base.toString()
  }
  // Equal paths on different owners must not share text or undo history. Why a leading folder,
  // not a fragment: Monaco's TypeScript service names files by the URI, so the file name must stay
  // last (its extension picks TSX) and one owner's files must sit in one tree for imports to resolve.
  return base
    .with({ path: `${OWNER_PREFIX}${ownerSegment(ownerKey)}${withoutOwner(base.path)}` })
    .toString()
}
