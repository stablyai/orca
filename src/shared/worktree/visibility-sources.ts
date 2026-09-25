import {
  createNormalizedPathInsideOrEqualMatcher,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../cross-platform-path'
import type {
  BuiltInWorktreeVisibilitySourceId,
  CustomWorktreeVisibilitySource,
  ExternalWorktreeVisibility,
  Repo,
  WorktreeVisibilitySourcePreferences
} from '../repo-types'
import type { WorktreeVisibilityDefaults } from '../global-settings-types'

export const MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES = 32
const MAX_SOURCE_ID_LENGTH = 128
const MAX_SOURCE_PATH_LENGTH = 4096

export const BUILT_IN_WORKTREE_VISIBILITY_SOURCES: readonly {
  id: BuiltInWorktreeVisibilitySourceId
  relativeRootSegments: readonly string[]
}[] = [
  { id: 'claude', relativeRootSegments: ['.claude', 'worktrees'] },
  { id: 'gsd', relativeRootSegments: ['.gsd-workspaces'] }
]

export type WorktreeVisibilitySourceMatch =
  | { kind: 'built-in'; id: BuiltInWorktreeVisibilitySourceId }
  | { kind: 'custom'; id: string }

export type WorktreeVisibilitySourceMatcher = (
  worktreePath: string
) => WorktreeVisibilitySourceMatch | null

function isValidSourceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SOURCE_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
}

function normalizeSourceRootPath(value: string): string | null {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > MAX_SOURCE_PATH_LENGTH ||
    trimmed.includes('\0') ||
    (trimmed.startsWith('\\') && !trimmed.startsWith('\\\\')) ||
    !isRuntimePathAbsolute(trimmed)
  ) {
    return null
  }
  return trimmed
}

export function normalizeCustomWorktreeVisibilitySources(
  value: unknown
): CustomWorktreeVisibilitySource[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const ids = new Set<string>()
  const roots = new Set<string>()
  const normalized: CustomWorktreeVisibilitySource[] = []
  for (const candidate of value) {
    if (normalized.length >= MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES) {
      break
    }
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const { id, rootPath } = candidate as { id?: unknown; rootPath?: unknown }
    if (typeof id !== 'string' || !isValidSourceId(id) || typeof rootPath !== 'string') {
      continue
    }
    const normalizedRootPath = normalizeSourceRootPath(rootPath)
    const rootKey = normalizedRootPath
      ? normalizeRuntimePathForComparison(normalizedRootPath)
      : null
    if (!normalizedRootPath || !rootKey || ids.has(id) || roots.has(rootKey)) {
      continue
    }
    ids.add(id)
    roots.add(rootKey)
    normalized.push({ id, rootPath: normalizedRootPath })
  }
  return normalized
}

function normalizeVisibility(value: unknown): ExternalWorktreeVisibility | undefined {
  return value === 'hide' || value === 'show' ? value : undefined
}

export function normalizeWorktreeVisibilitySourcePreferences(
  value: unknown
): WorktreeVisibilitySourcePreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as { builtIn?: unknown; custom?: unknown }
  const builtInValue =
    raw.builtIn && typeof raw.builtIn === 'object' && !Array.isArray(raw.builtIn)
      ? (raw.builtIn as Record<string, unknown>)
      : {}
  const builtIn = Object.fromEntries(
    BUILT_IN_WORKTREE_VISIBILITY_SOURCES.flatMap(({ id }) => {
      const visibility = normalizeVisibility(builtInValue[id])
      return visibility ? [[id, visibility]] : []
    })
  ) as WorktreeVisibilitySourcePreferences['builtIn']
  const customValue =
    raw.custom && typeof raw.custom === 'object' && !Array.isArray(raw.custom)
      ? (raw.custom as Record<string, unknown>)
      : {}
  const custom = Object.fromEntries(
    Object.entries(customValue)
      .filter(([id, visibility]) => isValidSourceId(id) && normalizeVisibility(visibility))
      .slice(0, MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES)
      .map(([id, visibility]) => [id, normalizeVisibility(visibility)!])
  )
  return {
    ...(Object.keys(builtIn ?? {}).length > 0 ? { builtIn } : {}),
    ...(Object.keys(custom).length > 0 ? { custom } : {})
  }
}

function createDescendantMatcher(rootPath: string): (normalizedCandidate: string) => boolean {
  const matchesInsideOrEqual = createNormalizedPathInsideOrEqualMatcher(rootPath)
  const normalizedRoot = normalizeRuntimePathForComparison(rootPath)
  return (normalizedCandidate) =>
    normalizedCandidate !== normalizedRoot && matchesInsideOrEqual(normalizedCandidate)
}

/**
 * Precondition: `configuredWorktreeBasePaths` are already resolved and free of
 * `.`/`..` segments — pass them through `resolveConfiguredWorktreeBasePaths`,
 * since a raw `.claude/worktrees/.` compares unequal and would not supersede.
 */
export function createWorktreeVisibilitySourceMatcher(
  checkoutPaths: readonly string[],
  customSources: readonly CustomWorktreeVisibilitySource[],
  configuredWorktreeBasePaths: readonly string[]
): WorktreeVisibilitySourceMatcher {
  const checkoutPathKeys = new Set(checkoutPaths.map(normalizeRuntimePathForComparison))
  const customMatchers = customSources.map(({ id, rootPath }) => ({
    id,
    matches: createDescendantMatcher(rootPath)
  }))
  const configuredBases = configuredWorktreeBasePaths.map((basePath) => ({
    key: normalizeRuntimePathForComparison(basePath),
    contains: createNormalizedPathInsideOrEqualMatcher(basePath)
  }))
  // Why: only a base pointing at or inside the matched root counts. A base of
  // `.` or `..` merely contains the root and must not exempt it (#9388).
  const isSupersededByConfiguredBase = (sourceRootKey: string, candidateKey: string): boolean =>
    configuredBases.some(
      (base) =>
        base.contains(candidateKey) &&
        (base.key === sourceRootKey || base.key.startsWith(`${sourceRootKey}/`))
    )
  return (worktreePath) => {
    const normalizedCandidate = normalizeRuntimePathForComparison(worktreePath)
    const segments = normalizedCandidate.split('/')
    for (const source of BUILT_IN_WORKTREE_VISIBILITY_SOURCES) {
      const prefix = source.relativeRootSegments
      for (let index = 0; index + prefix.length < segments.length; index += 1) {
        if (!prefix.every((segment, offset) => segments[index + offset] === segment)) {
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
    for (const source of customMatchers) {
      if (source.matches(normalizedCandidate)) {
        return { kind: 'custom', id: source.id }
      }
    }
    return null
  }
}

export function effectiveBuiltInWorktreeSourceVisibility(
  repo: Pick<Repo, 'agentWorktreeVisibility' | 'worktreeVisibilitySourcePreferences'>,
  sourceId: BuiltInWorktreeVisibilitySourceId,
  defaults?: WorktreeVisibilityDefaults
): ExternalWorktreeVisibility {
  const explicit = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )?.builtIn?.[sourceId]
  if (explicit) {
    return explicit
  }
  if (repo.agentWorktreeVisibility) {
    return repo.agentWorktreeVisibility
  }
  return effectiveDefaultBuiltInWorktreeSourceVisibility(defaults, sourceId)
}

export function effectiveCustomWorktreeSourceVisibility(
  repo: Pick<Repo, 'customWorktreeVisibilitySources' | 'worktreeVisibilitySourcePreferences'>,
  sourceId: string,
  defaults?: WorktreeVisibilityDefaults
): ExternalWorktreeVisibility {
  const explicit = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )?.custom?.[sourceId]
  if (explicit) {
    return explicit
  }
  const isRepoSource = normalizeCustomWorktreeVisibilitySources(
    repo.customWorktreeVisibilitySources
  )?.some((source) => source.id === sourceId)
  return isRepoSource ? 'hide' : effectiveDefaultCustomWorktreeSourceVisibility(defaults, sourceId)
}

export function effectiveWorktreeSourceVisibility(
  repo: Pick<
    Repo,
    | 'agentWorktreeVisibility'
    | 'customWorktreeVisibilitySources'
    | 'worktreeVisibilitySourcePreferences'
  >,
  source: WorktreeVisibilitySourceMatch,
  defaults?: WorktreeVisibilityDefaults
): ExternalWorktreeVisibility {
  return source.kind === 'built-in'
    ? effectiveBuiltInWorktreeSourceVisibility(repo, source.id, defaults)
    : effectiveCustomWorktreeSourceVisibility(repo, source.id, defaults)
}

export function effectiveDefaultBuiltInWorktreeSourceVisibility(
  defaults: WorktreeVisibilityDefaults | undefined,
  sourceId: BuiltInWorktreeVisibilitySourceId
): ExternalWorktreeVisibility {
  return normalizeWorktreeVisibilitySourcePreferences(defaults?.sourcePreferences)?.builtIn?.[
    sourceId
  ] === 'show'
    ? 'show'
    : 'hide'
}

export function effectiveDefaultCustomWorktreeSourceVisibility(
  defaults: WorktreeVisibilityDefaults | undefined,
  sourceId: string
): ExternalWorktreeVisibility {
  return normalizeWorktreeVisibilitySourcePreferences(defaults?.sourcePreferences)?.custom?.[
    sourceId
  ] === 'show'
    ? 'show'
    : 'hide'
}

export function resolveCustomWorktreeVisibilitySources(
  repo: Pick<Repo, 'customWorktreeVisibilitySources'>,
  defaults?: WorktreeVisibilityDefaults
): CustomWorktreeVisibilitySource[] {
  return (
    normalizeCustomWorktreeVisibilitySources([
      ...(normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []),
      ...(normalizeCustomWorktreeVisibilitySources(defaults?.customSources) ?? [])
    ]) ?? []
  )
}
