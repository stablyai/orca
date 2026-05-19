import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'
import type { Repo } from '../../../../shared/types'
import { filterProjectTableRowsByOpenRepos } from './project-row-filtering'

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1
  }
}

function row(id: string, repository: string | null): GitHubProjectRow {
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: 1,
      title: id,
      body: null,
      url: null,
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository,
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId: {},
    updatedAt: '2026-01-01T00:00:00Z',
    position: 0
  }
}

function table(rows: GitHubProjectRow[]): GitHubProjectTable {
  return {
    project: {
      id: 'P',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title: 'Project',
      url: 'https://github.com/orgs/acme/projects/1'
    },
    selectedView: {
      id: 'V',
      number: 1,
      name: 'Default',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

describe('filterProjectTableRowsByOpenRepos', () => {
  it('keeps rows whose repository slug resolves to at least one live repo', () => {
    const rows = [row('visible', 'acme/orca'), row('missing', 'acme/removed')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), (slug) =>
      slug?.toLowerCase() === 'acme/orca' ? [repo('repo-1')] : []
    )

    expect(filtered.rows.map((r) => r.id)).toEqual(['visible'])
    expect(filtered.totalCount).toBe(1)
  })

  it('keeps rows while any of multiple Orca repos map to the slug', () => {
    const rows = [row('visible', 'acme/orca')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), () => [
      repo('repo-1'),
      repo('repo-2')
    ])

    expect(filtered.rows.map((r) => r.id)).toEqual(['visible'])
  })

  it('filters missing or unresolved repository slugs', () => {
    const rows = [row('missing-slug', null), row('unresolved', 'gitlab/orca')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), () => [])

    expect(filtered.rows).toEqual([])
    expect(filtered.totalCount).toBe(0)
  })
})
