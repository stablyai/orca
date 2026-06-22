import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
import type { GlobalSettings, Repo } from '../../../shared/types'

export type RepoRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}

export function getRuntimeEnvironmentIdForRepo(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): string | null {
  if (!repoId) {
    return null
  }
  const repos = state.repos?.filter((entry) => entry.id === repoId) ?? []
  const repo = getActiveHostRepo(state, repos) ?? repos[0]
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

function getActiveHostRepo(
  state: RepoRuntimeOwnerState,
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
): Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | undefined {
  const activeRuntimeId = state.settings?.activeRuntimeEnvironmentId?.trim()
  const activeHostId = activeRuntimeId
    ? toRuntimeExecutionHostId(activeRuntimeId)
    : LOCAL_EXECUTION_HOST_ID
  return repos.find((repo) => getRepoExecutionHostId(repo) === activeHostId)
}

export function getSettingsForRepoRuntimeOwner(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return {
    ...state.settings,
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForRepo(state, repoId)
  }
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
