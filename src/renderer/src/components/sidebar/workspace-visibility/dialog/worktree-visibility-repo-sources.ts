import { getProjectSectionRepoLookup } from '../../../../../../shared/project-section-reveal'
import { useAppStore } from '@/store'
import type {
  CustomWorktreeVisibilitySource,
  Repo,
  WorktreeVisibilityDefaults
} from '../../../../../../shared/repo-types'
import {
  normalizeCustomWorktreeVisibilitySources,
  resolveCustomWorktreeVisibilitySources
} from '../../../../../../shared/worktree/visibility-sources'

export function getLatestRepoForVisibilityScope(scope: string): Repo | null {
  return getProjectSectionRepoLookup(useAppStore.getState().repos).get(scope) ?? null
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
