import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'
import type { Repo } from '../../../../shared/types'

export type ProjectRowSlugLookup = (
  slug: string | null | undefined,
  host?: string
) => readonly Repo[]

/** Origin matches own the slug through their own remote; upstream matches are
 *  forks whose parent the row names. */
export type ProjectRowSlugMatchLookup = (
  slug: string | null | undefined,
  host?: string
) => { origin: readonly Repo[]; upstream: readonly Repo[] }

export type SelectedProjectRowResolution =
  | { status: 'loading' }
  | { status: 'invalid_slug' }
  | { status: 'no_global_match' }
  | { status: 'unselected_match'; globalMatches: readonly Repo[] }
  | { status: 'selected_match'; repo: Repo; globalMatches: readonly Repo[] }
  | {
      status: 'ambiguous_selected_match'
      selectedMatches: readonly Repo[]
      globalMatches: readonly Repo[]
    }

export function resolveSelectedProjectRowRepo(input: {
  row: GitHubProjectRow
  lookupSlugMatches: ProjectRowSlugMatchLookup
  host?: string
  slugIndexReady: boolean
  selectedRepoIds: ReadonlySet<string>
}): SelectedProjectRowResolution {
  if (!input.slugIndexReady) {
    return { status: 'loading' }
  }

  const repository = input.row.content.repository
  if (!repository) {
    return { status: 'invalid_slug' }
  }
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) {
    return { status: 'invalid_slug' }
  }

  const { origin, upstream } = input.lookupSlugMatches(repository, input.host)
  const globalMatches = [...origin, ...upstream]
  if (globalMatches.length === 0) {
    return { status: 'no_global_match' }
  }

  // Why: prefer origin only among repos the user actually selected. Applying
  // that preference globally let an open-but-unselected clone of the upstream
  // repo hide the selected fork, reproducing #12647 for anyone holding both.
  const selectedOrigin = origin.filter((match) => input.selectedRepoIds.has(match.id))
  const selectedMatches =
    selectedOrigin.length > 0
      ? selectedOrigin
      : upstream.filter((match) => input.selectedRepoIds.has(match.id))
  if (selectedMatches.length === 0) {
    return { status: 'unselected_match', globalMatches }
  }
  if (selectedMatches.length === 1) {
    return { status: 'selected_match', repo: selectedMatches[0], globalMatches }
  }
  return { status: 'ambiguous_selected_match', selectedMatches, globalMatches }
}

export function projectRowHasOpenRepo(
  row: GitHubProjectRow,
  lookupSlug: ProjectRowSlugLookup,
  host?: string
): boolean {
  return lookupSlug(row.content.repository, host).length > 0
}

export function filterProjectTableRowsByOpenRepos(
  table: GitHubProjectTable,
  lookupSlug: ProjectRowSlugLookup
): GitHubProjectTable {
  const rows = table.rows.filter((row) =>
    projectRowHasOpenRepo(row, lookupSlug, table.project.host)
  )
  if (rows.length === table.rows.length && table.totalCount === rows.length) {
    return table
  }
  return { ...table, rows, totalCount: rows.length }
}

export function filterProjectTableRowsBySelectedRepos(
  table: GitHubProjectTable,
  lookupSlugMatches: ProjectRowSlugMatchLookup,
  slugIndexReady: boolean,
  selectedRepoIds: ReadonlySet<string>
): GitHubProjectTable {
  const rows = table.rows.filter((row) => {
    const resolution = resolveSelectedProjectRowRepo({
      row,
      lookupSlugMatches,
      host: table.project.host,
      slugIndexReady,
      selectedRepoIds
    })
    return (
      resolution.status === 'selected_match' || resolution.status === 'ambiguous_selected_match'
    )
  })
  if (rows.length === table.rows.length && table.totalCount === rows.length) {
    return table
  }
  return { ...table, rows, totalCount: rows.length }
}
