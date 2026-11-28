import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../file-access/cross-platform-path'
import type {
  BuiltInWorktreeVisibilitySourceId,
  CustomWorktreeVisibilitySource,
  ExternalWorktreeVisibility,
  Repo,
  WorktreeVisibilitySourcePreferences,
  WorktreeVisibilityDefaults
} from '../../repository/repo-types'
import {
  BUILT_IN_WORKTREE_VISIBILITY_SOURCES,
  createWorktreeVisibilitySourceMatcher,
  hasBuiltInWorktreeVisibilityCandidate,
  type WorktreeVisibilitySourceMatch,
  type WorktreeVisibilitySourceMatcher
} from './visibility-source-matcher'

export {
  BUILT_IN_WORKTREE_VISIBILITY_SOURCES,
  createWorktreeVisibilitySourceMatcher,
  hasBuiltInWorktreeVisibilityCandidate,
  type WorktreeVisibilitySourceMatch,
  type WorktreeVisibilitySourceMatcher
}

export const MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES = 32
const MAX_SOURCE_ID_LENGTH = 128
const MAX_SOURCE_PATH_LENGTH = 4096

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
  const hasRepoSources =
    Array.isArray(repo.customWorktreeVisibilitySources) &&
    repo.customWorktreeVisibilitySources.length > 0
  const hasDefaultSources =
    Array.isArray(defaults?.customSources) && defaults.customSources.length > 0
  if (!hasRepoSources && !hasDefaultSources) {
    return []
  }
  return (
    normalizeCustomWorktreeVisibilitySources([
      ...(hasRepoSources
        ? (normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? [])
        : []),
      ...(hasDefaultSources
        ? (normalizeCustomWorktreeVisibilitySources(defaults?.customSources) ?? [])
        : [])
    ]) ?? []
  )
}
