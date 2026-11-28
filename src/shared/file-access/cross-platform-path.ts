import { isWslUncPath } from './wsl-paths'

const SLASH_CHAR_CODE = '/'.charCodeAt(0)

export function isWindowsAbsolutePathLike(value: string): boolean {
  const c0 = value.charCodeAt(0)
  const c1 = value.charCodeAt(1)
  if (c0 === 47 || c0 === 92) {
    return c1 === c0
  }
  const c2 = value.charCodeAt(2)
  return (
    c1 === 58 && (c2 === 47 || c2 === 92) && ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))
  )
}

/** Git Bash/MSYS `/c/...` drive spelling as a native Windows path; other paths stay unchanged. */
export function msysDrivePathToWindows(path: string): string {
  const match = path.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  if (!match) {
    return path
  }

  const driveLetter = match[1].toUpperCase()
  const rest = match[2]?.replace(/\//g, '\\') ?? ''
  return rest ? `${driveLetter}:\\${rest}` : `${driveLetter}:\\`
}

/** Use path syntax, never client OS: Windows drive/UNC roots fold case; WSL UNC and POSIX/macOS stay case-sensitive to avoid merging distinct SSH/WSL files. */
export function isCaseInsensitiveRuntimeRoot(rootPath: string): boolean {
  return isWindowsAbsolutePathLike(rootPath) && !isWslUncPath(rootPath)
}

export function normalizeRelativePath(path: string, rootPath?: string | null): string {
  if (rootPath && !isWindowsAbsolutePathLike(rootPath)) {
    return path.replace(/^\/+/, '').replace(/\/+/g, '/')
  }
  return path.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/')
}

export function splitPathSegments(path: string, rootPath?: string | null): string[] {
  return normalizeRelativePath(path, rootPath).split('/').filter(Boolean)
}

export function normalizeRuntimePathSeparators(value: string): string {
  const normalized = collapseRuntimePathSlashes(
    value.includes('\\') ? value.replace(/\\/g, '/') : value
  )
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `//${normalized.replace(/^\/+/, '')}`
  }
  return normalized
}

/** Probe // before the dominant FS-event scan; includes is ~30x cheaper than unconditional replacement. */
function collapseRuntimePathSlashes(value: string): string {
  return value.includes('//') ? value.replace(/\/+/g, '/') : value
}

/** Comparison keys only, never real paths. NFC unifies macOS picker NFD with agent NFC (#10832); this knowingly permits canonical equivalence on byte-exact Linux/SSH hosts. */
export function normalizeRuntimePathForComparison(rawValue: string): string {
  // Normalize before any folding so the WSL alias branch below is covered too.
  const value = rawValue.normalize('NFC')
  const isWindowsPath = isWindowsAbsolutePathLike(value)
  // Backslash is legal in POSIX names; fold only paths proving Windows drive/UNC semantics.
  const normalized = trimRuntimePathTrailingSlash(
    isWindowsPath ? normalizeRuntimePathSeparators(value) : collapseRuntimePathSlashes(value)
  )
  if (!isWindowsPath) {
    return normalized
  }
  if (
    normalized.charCodeAt(0) === SLASH_CHAR_CODE &&
    normalized.charCodeAt(1) === SLASH_CHAR_CODE
  ) {
    const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i)
    if (wslUnc) {
      // WSL UNC aliases share a case-sensitive Linux tail; only distro/server components fold case.
      return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}`
    }
  }
  return normalized.toLowerCase()
}

export function isRuntimePathAbsolute(
  value: string,
  pathFlavor: 'posix' | 'windows' = isWindowsPathFlavor(value) ? 'windows' : 'posix'
): boolean {
  if (pathFlavor === 'windows') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\') || value.startsWith('/')
  }
  return value.startsWith('/')
}

export function resolveRuntimePath(basePath: string, targetPath: string): string {
  if (targetPath.startsWith('\\') && !targetPath.startsWith('\\\\')) {
    const { root } = splitRuntimePathRoot(normalizeRuntimePathSeparators(basePath), 'windows')
    return normalizeRuntimePathDots(`${root || '/'}${targetPath.slice(1)}`, 'windows')
  }
  const pathFlavor =
    isWindowsPathFlavor(basePath) || isWindowsPathFlavor(targetPath) ? 'windows' : 'posix'
  if (isRuntimePathAbsolute(targetPath, pathFlavor)) {
    return normalizeRuntimePathDots(targetPath, pathFlavor)
  }
  return normalizeRuntimePathDots(
    `${trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(basePath))}/${targetPath}`,
    pathFlavor
  )
}

export function getRuntimePathBasename(value: string): string {
  const last = value.charCodeAt(value.length - 1)
  const trimmed = last === SLASH_CHAR_CODE || last === 92 ? value.replace(/[\\/]+$/g, '') : value
  if (!trimmed) {
    return ''
  }
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/** Normalize roots once; require already-normalized candidates. WSL UNC normalization is not idempotent (a second pass lowercases the Linux tail), so raw candidates silently mismatch. */
export function createNormalizedPathInsideOrEqualMatcher(
  rootPath: string
): (normalizedCandidate: string) => boolean {
  const root = normalizeRuntimePathForComparison(rootPath)
  const rootWithBoundary =
    root === '/' || /^[a-z]:\/$/i.test(root) ? root : `${root.replace(/\/+$/, '')}/`
  return (normalizedCandidate) =>
    normalizedCandidate === root || normalizedCandidate.startsWith(rootWithBoundary)
}

export function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const root = normalizeRuntimePathForComparison(rootPath)
  const candidate = normalizeRuntimePathForComparison(candidatePath)
  if (candidate === root) {
    return true
  }
  if (root === '/' || /^[a-z]:\/$/i.test(root)) {
    return candidate.startsWith(root)
  }
  return candidate.startsWith(root) && candidate.charCodeAt(root.length) === SLASH_CHAR_CODE
}

export function relativePathInsideRoot(rootPath: string, candidatePath: string): string | null {
  const comparisonRoot = normalizeRuntimePathForComparison(rootPath)
  const comparisonCandidate = normalizeRuntimePathForComparison(candidatePath)
  if (comparisonCandidate === comparisonRoot) {
    return ''
  }
  const isRoot = comparisonRoot === '/' || /^[a-z]:\/$/i.test(comparisonRoot)
  if (
    !comparisonCandidate.startsWith(comparisonRoot) ||
    (!isRoot && comparisonCandidate.charCodeAt(comparisonRoot.length) !== SLASH_CHAR_CODE)
  ) {
    return null
  }
  // Classify Windows syntax on NFC too (Kelvin folds to K), preserving raw bytes for returned suffixes; otherwise comparison and slicing count different segments.
  const normalizedCandidate = trimRuntimePathTrailingSlash(
    isWindowsAbsolutePathLike(candidatePath.normalize('NFC'))
      ? normalizeRuntimePathSeparators(candidatePath)
      : collapseRuntimePathSlashes(candidatePath)
  )
  return sliceCandidatePastRootSegments(comparisonRoot, normalizedCandidate)
}

/** Skip whole root segments: NFC/case/UNC folding changes prefix lengths, so character slicing corrupts real suffixes. Scan without allocations during watcher storms. */
function sliceCandidatePastRootSegments(root: string, candidate: string): string {
  let remainingRootSegments = 0
  let inRootSegment = false
  for (let index = 0; index < root.length; index++) {
    if (root.charCodeAt(index) === SLASH_CHAR_CODE) {
      inRootSegment = false
    } else if (!inRootSegment) {
      inRootSegment = true
      remainingRootSegments++
    }
  }

  let inSegment = false
  for (let index = 0; index < candidate.length; index++) {
    if (candidate.charCodeAt(index) === SLASH_CHAR_CODE) {
      inSegment = false
      continue
    }
    if (!inSegment) {
      inSegment = true
      if (remainingRootSegments-- === 0) {
        return candidate.slice(index)
      }
    }
  }
  return ''
}

function trimRuntimePathTrailingSlash(value: string): string {
  // Nothing to trim, and neither preserved-root case can match, unless the value ends in `/`.
  if (!value.endsWith('/')) {
    return value
  }
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value
  }
  return value.replace(/\/+$/, '')
}

function isWindowsPathFlavor(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.startsWith('//')
}

function normalizeRuntimePathDots(value: string, pathFlavor: 'posix' | 'windows'): string {
  const normalized = normalizeRuntimePathSeparators(value)
  const { root, rest } = splitRuntimePathRoot(normalized, pathFlavor)
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }
  const suffix = segments.join('/')
  if (!root) {
    return suffix || '.'
  }
  return suffix ? `${root}${suffix}` : trimRuntimePathTrailingSlash(root)
}

function splitRuntimePathRoot(
  value: string,
  pathFlavor: 'posix' | 'windows'
): { root: string; rest: string } {
  if (pathFlavor === 'windows') {
    const drive = value.match(/^([A-Za-z]:)(?:\/|$)/)
    if (drive) {
      return { root: `${drive[1]}/`, rest: value.slice(drive[0].length) }
    }
    if (value.startsWith('//')) {
      const parts = value.slice(2).split('/')
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const root = `//${parts[0]}/${parts[1]}/`
        return { root, rest: parts.slice(2).join('/') }
      }
      return { root: '//', rest: value.slice(2) }
    }
    if (value.startsWith('/')) {
      return { root: '/', rest: value.slice(1) }
    }
  }
  if (value.startsWith('/')) {
    return { root: '/', rest: value.slice(1) }
  }
  return { root: '', rest: value }
}
