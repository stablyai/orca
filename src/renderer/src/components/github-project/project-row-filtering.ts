import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'
import type { Repo } from '../../../../shared/types'

export type ProjectRowSlugLookup = (slug: string | null | undefined) => readonly Repo[]

export function projectRowHasOpenRepo(
  row: GitHubProjectRow,
  lookupSlug: ProjectRowSlugLookup
): boolean {
  return lookupSlug(row.content.repository).length > 0
}

export function filterProjectTableRowsByOpenRepos(
  table: GitHubProjectTable,
  lookupSlug: ProjectRowSlugLookup
): GitHubProjectTable {
  const rows = table.rows.filter((row) => projectRowHasOpenRepo(row, lookupSlug))
  if (rows.length === table.rows.length && table.totalCount === rows.length) {
    return table
  }
  return { ...table, rows, totalCount: rows.length }
}
