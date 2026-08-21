import { normalizeRuntimePathSeparators } from './cross-platform-path'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from './worktree/visibility-sources'
import type { WorktreeVisibilityDefaults } from './global-settings-types'
import type { ExternalWorktreeVisibility, Repo } from './repo-types'

export const EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT = Date.UTC(2026, 4, 23)
export const UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH = 'Unknown location'

function trimRuntimePathTrailingSlash(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value
  }
  return value.replace(/\/+$/, '')
}

export function getExternalWorktreeParentPath(worktreePath: string | undefined): string {
  if (!worktreePath) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  const normalized = trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(worktreePath))
  if (!normalized) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/').filter(Boolean)
    if (parts.length < 2) {
      return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
    }
    if (parts.length === 2) {
      return `//${parts[0]}/${parts[1]}`
    }
    return `//${parts.slice(0, -1).join('/')}`
  }
  const lastSeparatorIndex = normalized.lastIndexOf('/')
  if (lastSeparatorIndex === -1) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  if (lastSeparatorIndex === 0) {
    return '/'
  }
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized
  }
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) {
    return `${normalized.slice(0, 2)}/`
  }
  return normalized.slice(0, lastSeparatorIndex)
}

export function isLegacyRepoForExternalWorktreeVisibility(repo: Repo): boolean {
  if (typeof repo.externalWorktreeVisibilityLegacy === 'boolean') {
    return repo.externalWorktreeVisibilityLegacy
  }
  if (repo.externalWorktreeVisibility === undefined) {
    return true
  }
  if (!Number.isFinite(repo.addedAt)) {
    return true
  }
  return repo.addedAt < EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
}

export function effectiveExternalWorktreeVisibility(
  repo: Pick<Repo, 'externalWorktreeVisibility'>,
  isLegacyRepoForVisibility: boolean,
  defaults?: WorktreeVisibilityDefaults
): ExternalWorktreeVisibility {
  if (repo.externalWorktreeVisibility) {
    return repo.externalWorktreeVisibility
  }
  if (defaults?.external === 'show' || defaults?.external === 'hide') {
    return defaults.external
  }
  return isLegacyRepoForVisibility ? 'show' : 'hide'
}

export function normalizeWorktreeVisibilityDefaults(
  value: unknown
): WorktreeVisibilityDefaults | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const {
    external,
    customSources: rawCustomSources,
    sourcePreferences: rawSourcePreferences,
    ...futureDefaults
  } = value as WorktreeVisibilityDefaults & Record<string, unknown>
  if (external !== 'show' && external !== 'hide') {
    return undefined
  }
  const customSources = normalizeCustomWorktreeVisibilitySources(rawCustomSources)
  const sourcePreferences = normalizeWorktreeVisibilitySourcePreferences(rawSourcePreferences)
  return {
    ...futureDefaults,
    external,
    ...(customSources !== undefined ? { customSources } : {}),
    ...(sourcePreferences !== undefined ? { sourcePreferences } : {})
  }
}

export function migrateExternalWorktreeVisibilityDefaults(
  repos: readonly Repo[],
  value: unknown
): {
  repos: Repo[]
  defaults: WorktreeVisibilityDefaults
  changed: boolean
} {
  const defaults = normalizeWorktreeVisibilityDefaults(value)
  if (defaults) {
    return { repos: [...repos], defaults, changed: false }
  }
  const migratedRepos = repos.map((repo) => {
    if (
      repo.kind === 'folder' ||
      repo.externalWorktreeVisibility !== undefined ||
      !isLegacyRepoForExternalWorktreeVisibility(repo)
    ) {
      return repo
    }
    return {
      ...repo,
      externalWorktreeVisibility: 'show' as const,
      externalWorktreeVisibilityLegacy: true
    }
  })
  return { repos: migratedRepos, defaults: { external: 'hide' }, changed: true }
}

export function effectiveAgentWorktreeVisibility(
  repo: Pick<Repo, 'agentWorktreeVisibility'>
): ExternalWorktreeVisibility {
  // Why: scratch worktrees have always defaulted hidden, including for legacy repos.
  return repo.agentWorktreeVisibility === 'show' ? 'show' : 'hide'
}
