import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../file-access/cross-platform-path'
import type {
  BuiltInWorktreeVisibilitySourceId,
  CustomWorktreeVisibilitySource
} from '../../repository/repo-types'

export const BUILT_IN_WORKTREE_VISIBILITY_SOURCES: readonly {
  id: BuiltInWorktreeVisibilitySourceId
  relativeRootSegments: readonly string[]
}[] = [
  { id: 'claude', relativeRootSegments: ['.claude', 'worktrees'] },
  { id: 'gsd', relativeRootSegments: ['.gsd-workspaces'] }
]

const BUILT_IN_WORKTREE_VISIBILITY_NEEDLES: readonly string[] =
  BUILT_IN_WORKTREE_VISIBILITY_SOURCES.map((source) => `${source.relativeRootSegments.join('/')}/`)

export type WorktreeVisibilitySourceMatch =
  | { kind: 'built-in'; id: BuiltInWorktreeVisibilitySourceId }
  | { kind: 'custom'; id: string }

export type WorktreeVisibilitySourceMatcher = (
  worktreePath: string
) => WorktreeVisibilitySourceMatch | null

export function hasBuiltInWorktreeVisibilityCandidate(normalizedPath: string): boolean {
  for (let i = 0; i < BUILT_IN_WORKTREE_VISIBILITY_NEEDLES.length; i += 1) {
    if (normalizedPath.includes(BUILT_IN_WORKTREE_VISIBILITY_NEEDLES[i])) {
      return true
    }
  }
  return false
}

function createDescendantMatcher(rootPath: string): (normalizedCandidate: string) => boolean {
  const matchesInsideOrEqual = createNormalizedPathInsideOrEqualMatcher(rootPath)
  const normalizedRoot = normalizeRuntimePathForComparison(rootPath)
  return (normalizedCandidate) =>
    normalizedCandidate !== normalizedRoot && matchesInsideOrEqual(normalizedCandidate)
}

/** Resolve configured bases through resolveConfiguredWorktreeBasePaths first; raw dot segments would prevent an explicit base superseding a scratch root. */
export function createWorktreeVisibilitySourceMatcher(
  checkoutPaths: readonly string[],
  customSources: readonly CustomWorktreeVisibilitySource[],
  configuredWorktreeBasePaths: readonly string[]
): WorktreeVisibilitySourceMatcher {
  const checkoutPathKeys = new Set<string>()
  for (let i = 0; i < checkoutPaths.length; i += 1) {
    checkoutPathKeys.add(normalizeRuntimePathForComparison(checkoutPaths[i]))
  }
  const customMatchers =
    customSources.length > 0
      ? customSources.map(({ id, rootPath }) => ({
          id,
          matches: createDescendantMatcher(rootPath)
        }))
      : null
  const configuredBases =
    configuredWorktreeBasePaths.length > 0
      ? configuredWorktreeBasePaths.map((basePath) => ({
          key: normalizeRuntimePathForComparison(basePath),
          contains: createNormalizedPathInsideOrEqualMatcher(basePath)
        }))
      : null
  // Only a base at/inside the matched root exempts it; an ancestor such as . or .. does not (#9388).
  const isSupersededByConfiguredBase = (sourceRootKey: string, candidateKey: string): boolean => {
    if (!configuredBases) {
      return false
    }
    for (let i = 0; i < configuredBases.length; i += 1) {
      const base = configuredBases[i]
      if (
        base.contains(candidateKey) &&
        (base.key === sourceRootKey ||
          (base.key.length > sourceRootKey.length &&
            base.key.startsWith(sourceRootKey) &&
            base.key.charCodeAt(sourceRootKey.length) === 47))
      ) {
        return true
      }
    }
    return false
  }
  return (worktreePath) => {
    const normalizedCandidate = normalizeRuntimePathForComparison(worktreePath)
    if (hasBuiltInWorktreeVisibilityCandidate(normalizedCandidate)) {
      const segments = normalizedCandidate.split('/')
      for (let s = 0; s < BUILT_IN_WORKTREE_VISIBILITY_SOURCES.length; s += 1) {
        const source = BUILT_IN_WORKTREE_VISIBILITY_SOURCES[s]
        if (!normalizedCandidate.includes(BUILT_IN_WORKTREE_VISIBILITY_NEEDLES[s])) {
          continue
        }
        const prefix = source.relativeRootSegments
        for (let index = 0; index + prefix.length < segments.length; index += 1) {
          let matched = true
          for (let offset = 0; offset < prefix.length; offset += 1) {
            if (segments[index + offset] !== prefix[offset]) {
              matched = false
              break
            }
          }
          if (!matched) {
            continue
          }
          const checkoutPath = segments.slice(0, index).join('/')
          const checkoutPathKey = /^[a-z]:$/i.test(checkoutPath)
            ? `${checkoutPath}/`
            : checkoutPath || '/'
          if (
            checkoutPathKeys.has(checkoutPathKey) &&
            !isSupersededByConfiguredBase(
              segments.slice(0, index + prefix.length).join('/'),
              normalizedCandidate
            )
          ) {
            return { kind: 'built-in', id: source.id }
          }
        }
      }
    }
    if (customMatchers) {
      for (let i = 0; i < customMatchers.length; i += 1) {
        if (customMatchers[i].matches(normalizedCandidate)) {
          return { kind: 'custom', id: customMatchers[i].id }
        }
      }
    }
    return null
  }
}
