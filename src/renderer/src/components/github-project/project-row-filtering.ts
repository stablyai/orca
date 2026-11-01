import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import type { Repo } from '../../../../shared/repo-types'

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

  // Prefer origins within selected repos only; an unselected upstream clone must not hide a selected fork.
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

export function filterProjectTableRowsBySelectedRepos(
  table: GitHubProjectTable,
  lookupSlugMatches: ProjectRowSlugMatchLookup,
  slugIndexReady: boolean,
  selectedRepoIds: ReadonlySet<string>
): GitHubProjectTable {
  const rows = table.rows.filter((row) => {
    // Drafts and restricted items belong to the Project, not a repository.
    // Keyed on kind so an older host's content-less Issue/PR rows stay hidden.
    if (row.itemType === 'DRAFT_ISSUE' || row.itemType === 'REDACTED') {
      return true
    }
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
