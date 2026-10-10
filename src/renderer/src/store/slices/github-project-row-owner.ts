import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'

type RepoOwnerState = {
  repos: readonly Repo[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

/** Transport for a GitHub Project row mutation. A row whose `owner/repo` slug matches a known
 *  repo goes to that repo's owner; otherwise (Orca may not track the repo) it goes to
 *  `rowSource`, the host the row was loaded from. */
export function runtimeTargetForProjectRowOwner(
  state: RepoOwnerState,
  owner: string,
  repo: string,
  host: string | undefined,
  rowSource: RuntimeClientTarget
): RuntimeClientTarget {
  const matchedRepo = lookupReposBySlugFromCache(state.repos, `${owner}/${repo}`, host)[0]
  return (matchedRepo ? runtimeTargetForRepoOwner(state, matchedRepo.id) : null) ?? rowSource
}
