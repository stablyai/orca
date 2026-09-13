/**
 * Verbatim pre-guard copy of `cross-platform-path.ts` and `parseWslUncPath`, kept only so
 * `cross-platform-path-guards.test.ts` can differentially fuzz the guarded versions
 * against what shipped. Comments were stripped; the code is otherwise unchanged. Update this file
 * only when the guarded originals are meant to change behaviour.
 */
import { toWindowsWslPath } from './wsl-paths'

type WslUncPathInfo = { distro: string; linuxPath: string }

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (!match) {
    return null
  }
  return { distro: match[2], linuxPath: match[3] || '/' }
}

function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}

const SLASH_CHAR_CODE = '/'.charCodeAt(0)

export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

export function isCaseInsensitiveRuntimeRoot(rootPath: string): boolean {
  return isWindowsAbsolutePathLike(rootPath) && !isWslUncPath(rootPath)
}

export function normalizeRuntimePathSeparators(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `//${normalized.replace(/^\/+/, '')}`
  }
  return normalized
}

export function normalizeRuntimePathForComparison(rawValue: string): string {
  const value = rawValue.normalize('NFC')
  const isWindowsPath = isWindowsAbsolutePathLike(value)
  const normalized = trimRuntimePathTrailingSlash(
    isWindowsPath ? normalizeRuntimePathSeparators(value) : value.replace(/\/+/g, '/')
  )
  const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i)
  if (wslUnc) {
    return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}`
  }
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

export function isWslUncPathForCallerLinuxPath(
  uncPath: string,
  linuxPath: string,
  callerDistro: string
): boolean {
  const parsed = parseWslUncPath(uncPath)
  if (!parsed) {
    return false
  }
  return (
    parsed.distro.toLowerCase() === callerDistro.toLowerCase() &&
    normalizeRuntimePathForComparison(parsed.linuxPath) ===
      normalizeRuntimePathForComparison(linuxPath)
  )
}

export function isWslUncPathForLinuxMountedPath(uncPath: string, linuxPath: string): boolean {
  const parsed = parseWslUncPath(uncPath)
  if (!parsed || !/^\/mnt\/[A-Za-z](?:\/|$)/.test(parsed.linuxPath)) {
    return false
  }
  if (!/^\/mnt\/[A-Za-z](?:\/|$)/.test(linuxPath)) {
    return false
  }
  return (
    normalizeRuntimePathForComparison(toWindowsWslPath(parsed.linuxPath, parsed.distro)) ===
    normalizeRuntimePathForComparison(toWindowsWslPath(linuxPath, parsed.distro))
  )
}

export function areLocalWindowsWslPathAliases(left: string, right: string): boolean {
  const leftIdentity = getLocalWindowsWslPathIdentity(left)
  const rightIdentity = getLocalWindowsWslPathIdentity(right)
  return (
    (leftIdentity.isWslUnc || rightIdentity.isWslUnc) &&
    leftIdentity.aliasComparisonPath === rightIdentity.aliasComparisonPath
  )
}

export type LocalWindowsWslPathIdentity = {
  normalizedPath: string
  aliasComparisonPath: string
  isWslUnc: boolean
}

export function getLocalWindowsWslPathIdentity(value: string): LocalWindowsWslPathIdentity {
  const wslPath = parseWslUncPath(value)
  const normalizedPath = normalizeRuntimePathForComparison(value)
  return {
    normalizedPath,
    aliasComparisonPath: wslPath
      ? normalizeRuntimePathForComparison(toWindowsWslPath(wslPath.linuxPath, wslPath.distro))
      : normalizedPath,
    isWslUnc: wslPath !== null
  }
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
