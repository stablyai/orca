import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'
import type { Repo } from '../../../../shared/types'

export type ProjectRowSlugLookup = (
  slug: string | null | undefined,
  host?: string
) => readonly Repo[]

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
  lookupSlug: ProjectRowSlugLookup
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

  const globalMatches = input.lookupSlug(repository, input.host)
  if (globalMatches.length === 0) {
    return { status: 'no_global_match' }
  }

  const selectedMatches = globalMatches.filter((match) => input.selectedRepoIds.has(match.id))
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
  lookupSlug: ProjectRowSlugLookup,
  slugIndexReady: boolean,
  selectedRepoIds: ReadonlySet<string>
): GitHubProjectTable {
  const rows = table.rows.filter((row) => {
    const resolution = resolveSelectedProjectRowRepo({
      row,
      lookupSlug,
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
