import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { GlobalSettings, Repo } from '../../../shared/types'

export type RepoRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}

function findRepoOwner(
  state: RepoRuntimeOwnerState,
  repoId: string
): Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null {
  const matchingRepos = state.repos?.filter((entry) => entry.id === repoId) ?? []
  if (matchingRepos.length === 0) {
    return null
  }
  if (matchingRepos.length === 1) {
    return matchingRepos[0]
  }
  const focusedHostId = getSettingsFocusedExecutionHostId(state.settings)
  const focusedMatches = matchingRepos.filter(
    (entry) => getRepoExecutionHostId(entry) === focusedHostId
  )
  // Why: duplicate bare repo ids are only safe to route when focus selects one
  // owner unambiguously; otherwise callers must avoid guessing a host.
  return focusedMatches.length === 1 ? focusedMatches[0] : null
}

export function getRuntimeEnvironmentIdForRepo(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): string | null {
  if (!repoId) {
    return null
  }
  const repo = findRepoOwner(state, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

// Why: PR mutations must not fall back to the globally focused runtime — a
// repo without an explicit owner is a local repo, and routing it to the
// focused runtime sends the mutation to a host that does not own it (#6957).
export function getExplicitRuntimeOwnerEnvironmentId(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): string | null {
  if (!repoId) {
    return null
  }
  const repo = findRepoOwner(state, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (!repo || !hasExplicitOwner) {
    return null
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

type OwnerRoutedSettingsCacheEntry = {
  settingsSource: RepoRuntimeOwnerState['settings']
  reposSource: RepoRuntimeOwnerState['repos']
  environmentId: string | null
  value: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
}

// Why keyed by repo id: every PR/task row calls this with its own repo while
// sharing one settings object, so a single-entry cache would thrash.
const ownerRoutedSettingsCache = new Map<string, OwnerRoutedSettingsCacheEntry>()
// Why bounded: repo ids come from remote listings, so the key space is not closed.
const MAX_OWNER_ROUTED_SETTINGS_CACHE_KEYS = 256

export function releaseRepoRuntimeOwnerSettingsCache(): void {
  ownerRoutedSettingsCache.clear()
}

export function getSettingsForRepoRuntimeOwner(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const environmentId = getRuntimeEnvironmentIdForRepo(state, repoId)
  // Why a stable identity: this runs inside useShallow selectors on every store
  // write, and spreading the whole settings object per row made unrelated writes
  // allocate and re-compare every field. Reusing the reference when nothing it
  // derives from changed lets useShallow settle on the Object.is fast path.
  const cacheKey = repoId ?? ''
  const cached = ownerRoutedSettingsCache.get(cacheKey)
  if (
    cached &&
    cached.settingsSource === state.settings &&
    cached.reposSource === state.repos &&
    cached.environmentId === environmentId
  ) {
    return cached.value
  }
  const value = {
    ...state.settings,
    activeRuntimeEnvironmentId: environmentId
  }
  ownerRoutedSettingsCache.set(cacheKey, {
    settingsSource: state.settings,
    reposSource: state.repos,
    environmentId,
    value
  })
  if (ownerRoutedSettingsCache.size > MAX_OWNER_ROUTED_SETTINGS_CACHE_KEYS) {
    const oldest = ownerRoutedSettingsCache.keys().next()
    if (!oldest.done) {
      ownerRoutedSettingsCache.delete(oldest.value)
    }
  }
  return value
}

// Why: git/file/terminal mutations must route by the OWNER host of the repo,
// not the currently focused runtime. This rebinds activeRuntimeEnvironmentId to
// the repo owner while preserving every other (display/AI) settings field.
export function getRepoOwnerRoutedSettings<T extends GlobalSettings | null>(
  settings: T,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null | undefined
): T {
  if (!settings) {
    return settings
  }
  const activeRuntimeEnvironmentId = getRuntimeEnvironmentIdForRepo(
    { repos: repo ? [repo] : [], settings },
    repo?.id ?? null
  )
  return { ...settings, activeRuntimeEnvironmentId }
}
