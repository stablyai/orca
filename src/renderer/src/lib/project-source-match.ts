import type { Repo } from '../../../shared/repo-types'

/** What a caller knows about the project it wants: where its files come from, and the ref to start on. */
export type ProjectSourceHint = { projectSource?: string; baseRef?: string }

/** The project for a hint, or why none fits. */
export type ProjectSourceMatch = { repoId: string } | { missing: string }

/**
 * One source-control kind's matcher. Returns null when the hint names nothing of its kind, so the
 * next kind can try; a verdict (match or missing) ends the search.
 */
export type ProjectSourceMatcher = (
  repos: readonly Repo[],
  hint: ProjectSourceHint,
  activeRepoId: string | null
) => ProjectSourceMatch | null | Promise<ProjectSourceMatch | null>

/** Highest score wins (0 never does); ties go to the active project, then local over SSH. */
export function pickBestProjectMatch(
  scored: readonly { repo: Pick<Repo, 'id' | 'connectionId'>; score: number }[],
  activeRepoId: string | null | undefined
): string | null {
  const isActive = (repo: Pick<Repo, 'id'>): number => Number(repo.id === activeRepoId)
  const isLocal = (repo: Pick<Repo, 'connectionId'>): number => Number(!repo.connectionId)
  const best = scored
    .filter((entry) => entry.score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        isActive(b.repo) - isActive(a.repo) ||
        isLocal(b.repo) - isLocal(a.repo)
    )[0]
  return best?.repo.id ?? null
}
