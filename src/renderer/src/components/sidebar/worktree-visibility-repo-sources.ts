import { useAppStore } from '@/store'
import type { CustomWorktreeVisibilitySource, Repo } from '../../../../shared/repo-types'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import {
  normalizeCustomWorktreeVisibilitySources,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'

export function getLatestRepoForVisibilityScope(scope: string): Repo | null {
  return useAppStore.getState().repos.find((repo) => getRepoHostIdentity(repo) === scope) ?? null
}

export function getRepoCustomWorktreeVisibilitySourceIds(repo: Repo | null): Set<string> {
  return new Set(
    normalizeCustomWorktreeVisibilitySources(repo?.customWorktreeVisibilitySources)?.map(
      (source) => source.id
    ) ?? []
  )
}

export function isDuplicateWorktreeVisibilitySource(
  repo: Repo,
  defaults: WorktreeVisibilityDefaults | undefined,
  candidate: CustomWorktreeVisibilitySource
): boolean {
  const current = resolveCustomWorktreeVisibilitySources(repo, defaults)
  return (
    normalizeCustomWorktreeVisibilitySources([...current, candidate])?.length !== current.length + 1
  )
}
