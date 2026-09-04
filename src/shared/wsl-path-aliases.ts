import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/**
 * Root spellings that explicitly identify one Windows/WSL filesystem path.
 *
 * Claude in a WSL pane records `/mnt/c/...` even when Orca's worktree is `C:\...`.
 * A raw `/mnt/c` root stays POSIX because its syntax alone does not prove WSL.
 */
export function wslRootPathAliases(pathValue: string): string[] {
  const unc = mightBeWslUncPath(pathValue) ? parseWslUncPath(pathValue) : null
  const driveMount = mightBeWindowsDrivePath(pathValue)
    ? wslMountPathFromWindowsDrive(pathValue)
    : null
  if (!unc && !driveMount) {
    return [pathValue]
  }

  const aliases: string[] = []
  const seen = new Set<string>()
  const add = (value: string | null) => {
    if (!value || seen.has(value)) {
      return
    }
    seen.add(value)
    aliases.push(value)
  }

  add(pathValue)

  if (unc) {
    add(unc.linuxPath)
    add(windowsDrivePathFromWslMount(unc.linuxPath))
  }

  add(driveMount)

  return aliases
}

/** Candidate spellings include a potential drive alias that only an explicit root can match. */
export function normalizedWslPathCandidateAliases(pathValue: string): string[] {
  const normalizedPath = normalizeRuntimePathForComparison(pathValue)
  const linuxPath = mightBeWslUncPath(pathValue)
    ? (parseWslUncPath(pathValue)?.linuxPath ?? pathValue)
    : pathValue
  const windowsPath = windowsDrivePathFromWslMount(linuxPath)
  if (!windowsPath) {
    return [normalizedPath]
  }
  const normalizedWindowsPath = normalizeRuntimePathForComparison(windowsPath)
  return normalizedPath === normalizedWindowsPath
    ? [normalizedPath]
    : [normalizedPath, normalizedWindowsPath]
}

export function wslAliasedPathDepth(pathValue: string): number {
  const canonicalPath =
    (mightBeWslUncPath(pathValue) ? parseWslUncPath(pathValue)?.linuxPath : null) ??
    (mightBeWindowsDrivePath(pathValue) ? wslMountPathFromWindowsDrive(pathValue) : null) ??
    pathValue
  return normalizeRuntimePathForComparison(canonicalPath).split('/').filter(Boolean).length
}

export function createWslAliasedPathInsideOrEqualMatcher(
  rootPath: string
): (normalizedCandidate: string) => boolean {
  const aliases = wslRootPathAliases(rootPath)
  if (aliases.length === 1) {
    return createNormalizedPathInsideOrEqualMatcher(aliases[0])
  }
  const matchers = aliases.map(createNormalizedPathInsideOrEqualMatcher)
  return (normalizedCandidate) => matchers.some((ownsPath) => ownsPath(normalizedCandidate))
}

/** Precomputes every root spelling before matching a session/path fanout. */
export function createWslAliasedPathInsideOrEqualScopeMatcher(
  rootPaths: readonly string[]
): (candidatePath: string) => boolean {
  const rootMatchers = rootPaths.map(createWslAliasedPathInsideOrEqualMatcher)
  return (candidatePath) => {
    const candidateAliases = normalizedWslPathCandidateAliases(candidatePath)
    if (candidateAliases.length === 1) {
      return rootMatchers.some((ownsPath) => ownsPath(candidateAliases[0]))
    }
    return rootMatchers.some((ownsPath) => candidateAliases.some(ownsPath))
  }
}

export function isWslAliasedPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const ownsPath = createWslAliasedPathInsideOrEqualMatcher(rootPath)
  return normalizedWslPathCandidateAliases(candidatePath).some(ownsPath)
}

function wslMountPathFromWindowsDrive(pathValue: string): string | null {
  const match = pathValue.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!match) {
    return null
  }
  const rest = match[2].replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

function windowsDrivePathFromWslMount(pathValue: string): string | null {
  const match = pathValue.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (!match) {
    return null
  }
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${rest || '\\'}`
}

function mightBeWindowsDrivePath(pathValue: string): boolean {
  return pathValue.length >= 3 && pathValue.charCodeAt(1) === 58
}

function mightBeWslUncPath(pathValue: string): boolean {
  return pathValue.startsWith('\\\\') || pathValue.startsWith('//')
}
