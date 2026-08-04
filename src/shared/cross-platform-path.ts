const SLASH_CHAR_CODE = '/'.charCodeAt(0)

export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

export function normalizeRuntimePathSeparators(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `//${normalized.replace(/^\/+/, '')}`
  }
  return normalized
}

/**
 * Comparison key only — never return this as, or splice it into, a real path.
 *
 * Why NFC: macOS file pickers and on-disk names yield NFD, while agents such as
 * Claude Code record cwd and encode their project directory names in NFC. Both
 * spell the same file, so a non-ASCII workspace otherwise never matches its own
 * sessions (#10832). Folding here knowingly treats canonically equivalent names
 * as one, which is exact on APFS but permissive on byte-exact Linux/SSH hosts —
 * an acceptable trade, since only comparison keys are affected.
 */
export function normalizeRuntimePathForComparison(rawValue: string): string {
  // Normalize before any folding so the WSL alias branch below is covered too.
  const value = rawValue.normalize('NFC')
  const isWindowsPath = isWindowsAbsolutePathLike(value)
  // Why: backslash is a valid POSIX filename character; fold it only when the
  // path itself proves Windows drive/UNC semantics.
  const normalized = trimRuntimePathTrailingSlash(
    isWindowsPath ? normalizeRuntimePathSeparators(value) : value.replace(/\/+/g, '/')
  )
  const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i)
  if (wslUnc) {
    // Why: Windows exposes the same case-sensitive WSL filesystem through two
    // UNC aliases, while the distro/server portion remains case-insensitive.
    return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}`
  }
  return isWindowsPath ? normalized.toLowerCase() : normalized
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
  const trimmed = value.replace(/[\\/]+$/g, '')
  if (!trimmed) {
    return ''
  }
  return trimmed.split(/[\\/]/).findLast(Boolean) ?? ''
}

/**
 * Pre-normalizes the root so a fan-out normalizes it once, not once per candidate.
 *
 * Why the name says "normalized": candidates must already be run through
 * `normalizeRuntimePathForComparison`. That function is not idempotent for WSL UNC
 * paths (`//wsl.localhost/Ubuntu/A` folds to `//wsl/ubuntu/A`, which a second pass
 * lowercases further), so a raw candidate here would silently fail to match.
 */
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
  return createNormalizedPathInsideOrEqualMatcher(rootPath)(
    normalizeRuntimePathForComparison(candidatePath)
  )
}

export function relativePathInsideRoot(rootPath: string, candidatePath: string): string | null {
  // Why: decide Windows-ness on the same NFC form the comparison key uses, or the
  // two disagree (U+212A folds to 'K', making only one side a drive path) and the
  // segment counts desync. Only the branch test sees NFC — the sliced string stays
  // raw so the returned suffix remains byte-exact.
  const normalizedCandidate = trimRuntimePathTrailingSlash(
    isWindowsAbsolutePathLike(candidatePath.normalize('NFC'))
      ? normalizeRuntimePathSeparators(candidatePath)
      : candidatePath.replace(/\/+/g, '/')
  )
  const comparisonRoot = normalizeRuntimePathForComparison(rootPath)
  const comparisonCandidate = normalizeRuntimePathForComparison(candidatePath)

  if (comparisonCandidate === comparisonRoot) {
    return ''
  }
  const isRoot = comparisonRoot === '/' || /^[a-z]:\/$/i.test(comparisonRoot)
  const comparisonPrefix = isRoot ? comparisonRoot : `${comparisonRoot}/`
  if (!comparisonCandidate.startsWith(comparisonPrefix)) {
    return null
  }
  return sliceCandidatePastRootSegments(comparisonRoot, normalizedCandidate)
}

/**
 * Why: skip whole root segments rather than a character count. Comparison
 * folding (NFC, case, UNC alias) changes length, so a folded-prefix length would
 * cut the raw candidate mid-character and fabricate a path; segment positions
 * survive every fold and keep the suffix byte-exact. Scanning rather than
 * splitting keeps watcher event storms allocation-free.
 */
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
