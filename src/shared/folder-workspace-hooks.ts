import type { OrcaHooks } from './orca-yaml-hook-types'
import type { Repo } from './repo-types'
import { isFolderRepo } from './repo-kind'

/** Folder workspaces share one directory, so orca.yaml default tabs would start again for every one. */
export function scopeHooksToRepoKind(
  repo: Pick<Repo, 'kind'>,
  hooks: OrcaHooks | null
): OrcaHooks | null {
  if (!hooks || !isFolderRepo(repo) || !hooks.defaultTabs) {
    return hooks
  }
  return { ...hooks, defaultTabs: undefined }
}
