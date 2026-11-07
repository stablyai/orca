import { isWindowsAbsolutePathLike } from './cross-platform-path'

/**
 * Prefix matching for a path the user is still typing.
 *
 * Why this is not `normalizeRuntimePathForComparison`: that function infers path
 * flavor from the value it is given, which a half-typed prefix cannot supply.
 * `C`, `C:`, `//WSL.LOCALHOST` and a first separator are all valid partial
 * spellings of a real workspace whose own syntax proves nothing, so normalizing
 * the typed text alone blanks the list on exactly the rows the user is aiming at.
 * The candidate supplies the flavor instead, and both sides are then prepared the
 * same way and compared literally.
 */
export type RuntimePathPrefixKey = {
  /**
   * Two prepared spellings of the candidate; comparison keys, never real paths.
   *
   * Why two: no single whole-string normalization is prefix-preserving. NFC
   * merges `e` + U+0301 into `é` and destroys a boundary that stops at the `e`;
   * NFD keeps code points separate but canonically reorders combining marks, so
   * a boundary between two marks moves. `decomposed` buys canonical equivalence
   * across NFC/NFD spellings, `ordered` keeps the candidate's own mark order, and
   * a prefix only has to survive one of them.
   *
   * Known boundary: this covers the candidate's own mark order plus its NFD
   * order. A prefix cut mid-sequence from some third canonically equivalent
   * ordering still misses. Exhausting that needs a normalization-boundary-aware
   * comparator, which is not worth its cost for a path filter — no more
   * whole-string spellings can close it.
   */
  decomposedPath: string
  orderedPath: string
  windows: boolean
  fold: RuntimePathFoldMode
}

/**
 * How much of a value folds case.
 *
 * `all` is a drive or plain UNC path; `wsl-head` folds only the share alias and
 * distro, because below the distro is a case-sensitive Linux filesystem; `none`
 * is POSIX, where folding would merge genuinely distinct files.
 */
type RuntimePathFoldMode = 'none' | 'all' | 'wsl-head'

const WSL_UNC_ALIAS = /^\/\/(?:wsl\.localhost|wsl\$)(?=\/|$)/i
const CANONICAL_WSL_UNC_ALIAS = '//wsl.localhost'
const FINAL_SIGMA = /\u03c2/g
const MEDIAL_SIGMA = '\u03c3'

/** Build once per candidate; the fan-out prepares only the short typed prefix. */
export function prepareRuntimePathPrefixKey(candidatePath: string): RuntimePathPrefixKey {
  const windows = isWindowsAbsolutePathLike(candidatePath)
  const decomposed = canonicalizeForPrefixMatch(candidatePath, windows, true)
  const fold: RuntimePathFoldMode = !windows
    ? 'none'
    : WSL_UNC_ALIAS.test(decomposed)
      ? 'wsl-head'
      : 'all'
  return {
    decomposedPath: foldForPrefixMatch(decomposed, fold),
    orderedPath: foldForPrefixMatch(
      canonicalizeForPrefixMatch(candidatePath, windows, false),
      fold
    ),
    windows,
    fold
  }
}

export function matchesRuntimePathPrefix(key: RuntimePathPrefixKey, typedPrefix: string): boolean {
  const prepare = (decompose: boolean): string =>
    foldForPrefixMatch(canonicalizeForPrefixMatch(typedPrefix, key.windows, decompose), key.fold)
  return (
    matchesPreparedPath(key.decomposedPath, prepare(true)) ||
    matchesPreparedPath(key.orderedPath, prepare(false))
  )
}

function matchesPreparedPath(path: string, prefix: string): boolean {
  if (path.startsWith(prefix)) {
    return true
  }
  // Why: a trailing separator pins the prefix to a whole segment, so `/repo/`
  // never matches `/repository`. It should still match the pinned directory
  // itself, not only its descendants.
  const pinned = prefix.slice(0, -1)
  // Why the guard: a root prefix has no parent segment to pin to. Without it a
  // bare `//` would equal the POSIX root `/`, contradicting the canonicalizer's
  // deliberate treatment of a leading `//` as UNC syntax rather than a separator.
  return prefix.endsWith('/') && pinned.length > 0 && !pinned.endsWith('/') && path === pinned
}

function canonicalizeForPrefixMatch(value: string, windows: boolean, decompose: boolean): string {
  // Why NFD rather than the NFC the equality helpers use: both give the same
  // canonical equivalence, but composition merges `e` + U+0301 into `é` and so
  // destroys the boundary of a prefix that stops at the `e`. Decomposition never
  // merges code points; the caller pairs it with the undecomposed spelling to
  // cover the marks NFD reorders.
  const decomposed = decompose ? value.normalize('NFD') : value
  // Why: backslash is a legal POSIX filename character, including on SSH and
  // folder workspaces, so fold it only when the candidate proves Windows syntax.
  const separators = windows ? decomposed.replace(/\\/g, '/') : decomposed
  // Why the negative lookahead: a leading `//` is UNC syntax, not a doubled
  // separator, so only interior runs collapse.
  const collapsed = separators.replace(/(?!^)\/+/g, '/')
  return windows ? collapsed.replace(WSL_UNC_ALIAS, CANONICAL_WSL_UNC_ALIAS) : collapsed
}

/**
 * Why each value finds its own boundary instead of sharing a cached offset:
 * lowercasing can change length (U+0130 folds to two code units), so a boundary
 * measured on the candidate can land mid-segment in the prefix — which both hides
 * an equivalent distro spelling and folds a case-sensitive Linux name.
 */
function foldForPrefixMatch(canonical: string, fold: RuntimePathFoldMode): string {
  if (fold === 'none') {
    return canonical
  }
  if (fold === 'all') {
    return foldCase(canonical)
  }
  const headEnd = getWslCaseInsensitiveHeadEnd(canonical)
  return `${foldCase(canonical.slice(0, headEnd))}${canonical.slice(headEnd)}`
}

/**
 * Why the sigma replacement: `toLowerCase` is context-sensitive. A capital sigma
 * at the end of a word becomes final sigma, so the typed prefix `C:\ΑΣ` folds to
 * `c:/ας` while the row `C:\ΑΣΧ` folds to `c:/ασχ` — and a prefix being typed is
 * always at a word end. Windows uppercases both sigmas to Σ and treats them as
 * one name, so folding them together matches the filesystem too.
 */
function foldCase(value: string): string {
  return value.toLowerCase().replace(FINAL_SIGMA, MEDIAL_SIGMA)
}

function getWslCaseInsensitiveHeadEnd(canonical: string): number {
  // Why: a prefix still inside the alias has no distro yet, so all of it folds.
  if (!WSL_UNC_ALIAS.test(canonical)) {
    return canonical.length
  }
  const distroEnd = canonical.indexOf('/', CANONICAL_WSL_UNC_ALIAS.length + 1)
  return distroEnd === -1 ? canonical.length : distroEnd
}
