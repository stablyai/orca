import type { GlobalSettings, Repo } from '../../../../shared/types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'

type RepoOwnerState = {
  repos: readonly Repo[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

/** Resolve the runtime settings to route a GitHub Project row mutation through.
 *  When the row's `owner/repo` slug matches a known repo, route by that repo's
 *  owner host; otherwise fall back to the focused settings (the row may belong
 *  to a repo Orca doesn't track). */
export function settingsForProjectRowOwner(
  state: RepoOwnerState,
  owner: string,
  repo: string,
  host?: string,
  fallbackSettings:
    | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
    | null
    | undefined = state.settings
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  const matchedRepo = lookupReposBySlugFromCache(
    state.repos,
    state.settings,
    `${owner}/${repo}`,
    host
  )[0]
  return matchedRepo ? getSettingsForRepoRuntimeOwner(state, matchedRepo.id) : fallbackSettings
}
