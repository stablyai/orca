import {
  isCaseInsensitiveRuntimeRoot,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../cross-platform-path'
import { isSafePluginCapabilityPath } from './plugin-capability-scope'

export type PluginReadGrant = Readonly<{ paths: readonly string[] }>

export const PLUGIN_READ_MANDATORY_DENIED_PATH_FAMILIES = [
  { label: '.git/**', match: 'exact', value: '.git' },
  { label: '.env*', match: 'prefix', value: '.env' },
  { label: '.npmrc', match: 'exact', value: '.npmrc' },
  { label: '.netrc', match: 'exact', value: '.netrc' },
  { label: '.ssh/**', match: 'exact', value: '.ssh' },
  { label: '.aws/**', match: 'exact', value: '.aws' },
  { label: '*.pem', match: 'suffix', value: '.pem' },
  { label: '*.key', match: 'suffix', value: '.key' },
  { label: 'id_rsa*', match: 'prefix', value: 'id_rsa' }
] as const

export const PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS =
  PLUGIN_READ_MANDATORY_DENIED_PATH_FAMILIES.map(({ label }) => label)

function segmentMatches(pattern: string, candidate: string): boolean {
  let patternIndex = 0
  let candidateIndex = 0
  let starIndex = -1
  let retryIndex = 0

  while (candidateIndex < candidate.length) {
    if (pattern[patternIndex] === candidate[candidateIndex]) {
      patternIndex++
      candidateIndex++
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex++
      retryIndex = candidateIndex
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      candidateIndex = ++retryIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') {
    patternIndex++
  }
  return patternIndex === pattern.length
}

function pathMatches(pattern: string, candidate: string): boolean {
  const patternSegments = pattern.split('/')
  const candidateSegments = candidate === '' ? [] : candidate.split('/')
  const pending: [number, number][] = [[0, 0]]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const [patternIndex, candidateIndex] = pending.pop()!
    const state = `${patternIndex}:${candidateIndex}`
    if (visited.has(state)) {
      continue
    }
    visited.add(state)

    if (patternIndex === patternSegments.length) {
      if (candidateIndex === candidateSegments.length) {
        return true
      }
      continue
    }
    if (patternSegments[patternIndex] === '**') {
      pending.push([patternIndex + 1, candidateIndex])
      if (candidateIndex < candidateSegments.length) {
        pending.push([patternIndex, candidateIndex + 1])
      }
    } else if (
      candidateIndex < candidateSegments.length &&
      segmentMatches(patternSegments[patternIndex], candidateSegments[candidateIndex])
    ) {
      pending.push([patternIndex + 1, candidateIndex + 1])
    }
  }
  return false
}

function isMandatoryDeniedPath(candidate: string): boolean {
  return candidate.split('/').some((segment) => {
    const folded = segment.toLowerCase()
    return PLUGIN_READ_MANDATORY_DENIED_PATH_FAMILIES.some((family) => {
      switch (family.match) {
        case 'exact':
          return folded === family.value
        case 'prefix':
          return folded.startsWith(family.value)
        case 'suffix':
          return folded.endsWith(family.value)
      }
    })
  })
}

export function isPluginReadAllowed(
  canonicalRoot: string,
  canonicalTarget: string,
  grant: PluginReadGrant | null | undefined
): boolean {
  if (!canonicalRoot || !canonicalTarget || !grant?.paths.length) {
    return false
  }
  if (!grant.paths.every(isSafePluginCapabilityPath)) {
    return false
  }

  const relativePath = relativePathInsideRoot(canonicalRoot, canonicalTarget)
  if (relativePath === null) {
    return false
  }

  const candidate = isWindowsAbsolutePathLike(canonicalRoot)
    ? normalizeRuntimePathSeparators(relativePath)
    : relativePath
  // Dot-prefixed names match normally; only the mandatory sensitive families are refused.
  if (isMandatoryDeniedPath(candidate)) {
    return false
  }
  const caseInsensitive = isCaseInsensitiveRuntimeRoot(canonicalRoot)
  const comparisonCandidate = caseInsensitive ? candidate.toLowerCase() : candidate
  return grant.paths.some((path) =>
    pathMatches(caseInsensitive ? path.toLowerCase() : path, comparisonCandidate)
  )
}
