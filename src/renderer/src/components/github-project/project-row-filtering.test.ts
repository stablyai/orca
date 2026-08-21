import { describe, expect, it, vi } from 'vitest'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  filterProjectTableRowsByOpenRepos,
  filterProjectTableRowsBySelectedRepos,
  resolveSelectedProjectRowRepo
} from './project-row-filtering'

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1
  }
}

/** The common case: every match owns the slug through its own origin remote. */
function originOnly(matches: Repo[]): { origin: Repo[]; upstream: Repo[] } {
  return { origin: matches, upstream: [] }
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
    const rows = [row('visible', 'acme/mcode'), row('missing', 'acme/removed')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), (slug) =>
      slug?.toLowerCase() === 'acme/mcode' ? [repo('repo-1')] : []
    )

    expect(filtered.rows.map((r) => r.id)).toEqual(['visible'])
    expect(filtered.totalCount).toBe(1)
  })

  it('keeps rows while any of multiple MCode repos map to the slug', () => {
    const rows = [row('visible', 'acme/mcode')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), () => [
      repo('repo-1'),
      repo('repo-2')
    ])

    expect(filtered.rows.map((r) => r.id)).toEqual(['visible'])
  })

  it('filters missing or unresolved repository slugs', () => {
    const rows = [row('missing-slug', null), row('unresolved', 'gitlab/mcode')]
    const filtered = filterProjectTableRowsByOpenRepos(table(rows), () => [])

    expect(filtered.rows).toEqual([])
    expect(filtered.totalCount).toBe(0)
  })
})

describe('filterProjectTableRowsBySelectedRepos', () => {
  it('keeps a row when at least one slug match is selected', () => {
    const rows = [row('visible', 'acme/mcode'), row('hidden', 'acme/tool')]
    const filtered = filterProjectTableRowsBySelectedRepos(
      table(rows),
      (slug) =>
        originOnly(slug?.toLowerCase() === 'acme/mcode' ? [repo('repo-1')] : [repo('repo-2')]),
      true,
      new Set(['repo-1'])
    )

    expect(filtered.rows.map((r) => r.id)).toEqual(['visible'])
    expect(filtered.totalCount).toBe(1)
  })

  it('filters a row when only unselected repos match', () => {
    const rows = [row('hidden', 'acme/mcode')]
    const filtered = filterProjectTableRowsBySelectedRepos(
      table(rows),
      () => originOnly([repo('repo-2')]),
      true,
      new Set(['repo-1'])
    )

    expect(filtered.rows).toEqual([])
    expect(filtered.totalCount).toBe(0)
  })

  it('keeps a row whose only selected match is a fork of the row s repo', () => {
    const rows = [row('fork-only', 'acme/mcode')]
    const filtered = filterProjectTableRowsBySelectedRepos(
      table(rows),
      () => ({ origin: [], upstream: [repo('fork')] }),
      true,
      new Set(['fork'])
    )

    expect(filtered.rows.map((r) => r.id)).toEqual(['fork-only'])
    expect(filtered.totalCount).toBe(1)
  })

  it('keeps a row with multiple selected matches for action ambiguity handling', () => {
    const rows = [row('ambiguous', 'acme/mcode')]
    const filtered = filterProjectTableRowsBySelectedRepos(
      table(rows),
      () => originOnly([repo('repo-1'), repo('repo-2'), repo('repo-3')]),
      true,
      new Set(['repo-1', 'repo-2'])
    )

    expect(filtered.rows.map((r) => r.id)).toEqual(['ambiguous'])
  })
})

describe('resolveSelectedProjectRowRepo', () => {
  it('reports loading without reading stale slug matches', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('loading', 'acme/mcode'),
      lookupSlugMatches: () => {
        throw new Error('should not read stale matches')
      },
      slugIndexReady: false,
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(resolution.status).toBe('loading')
  })

  it('reports invalid slug for rows without a repository', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('missing-slug', null),
      lookupSlugMatches: () => originOnly([repo('repo-1')]),
      slugIndexReady: true,
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(resolution.status).toBe('invalid_slug')
  })

  it('reports no global match when MCode has no repo for the slug', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('missing', 'acme/mcode'),
      lookupSlugMatches: () => originOnly([]),
      slugIndexReady: true,
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(resolution.status).toBe('no_global_match')
  })

  it('reports global-only matches when the repo is not selected', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('unselected', 'acme/mcode'),
      lookupSlugMatches: () => originOnly([repo('repo-2')]),
      slugIndexReady: true,
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(resolution.status).toBe('unselected_match')
  })

  it('returns the selected match when exactly one matching repo is selected', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('selected', 'acme/mcode'),
      lookupSlugMatches: () => originOnly([repo('repo-1'), repo('repo-2')]),
      slugIndexReady: true,
      selectedRepoIds: new Set(['repo-2'])
    })

    expect(resolution).toMatchObject({ status: 'selected_match', repo: { id: 'repo-2' } })
  })

  it('passes the project host into repository matching', () => {
    const lookupSlugMatches = vi.fn(() => originOnly([repo('repo-1')]))

    expect(
      resolveSelectedProjectRowRepo({
        row: row('enterprise', 'acme/mcode'),
        lookupSlugMatches,
        host: 'ghe.example:8443',
        slugIndexReady: true,
        selectedRepoIds: new Set(['repo-1'])
      })
    ).toMatchObject({ status: 'selected_match' })
    expect(lookupSlugMatches).toHaveBeenCalledWith('acme/mcode', 'ghe.example:8443')
  })

  it('reports ambiguity when multiple matching repos are selected', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('ambiguous', 'acme/mcode'),
      lookupSlugMatches: () => originOnly([repo('repo-1'), repo('repo-2')]),
      slugIndexReady: true,
      selectedRepoIds: new Set(['repo-1', 'repo-2'])
    })

    expect(resolution.status).toBe('ambiguous_selected_match')
  })

  it('falls through to a selected fork when the upstream clone is unselected', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('fork-selected', 'acme/mcode'),
      lookupSlugMatches: () => ({ origin: [repo('upstream')], upstream: [repo('fork')] }),
      slugIndexReady: true,
      selectedRepoIds: new Set(['fork'])
    })

    expect(resolution).toMatchObject({ status: 'selected_match', repo: { id: 'fork' } })
  })

  it('prefers the selected upstream clone over a selected fork of it', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('both-selected', 'acme/mcode'),
      lookupSlugMatches: () => ({ origin: [repo('upstream')], upstream: [repo('fork')] }),
      slugIndexReady: true,
      selectedRepoIds: new Set(['upstream', 'fork'])
    })

    expect(resolution).toMatchObject({ status: 'selected_match', repo: { id: 'upstream' } })
  })

  it('still reports no selection when neither the upstream clone nor the fork is selected', () => {
    const resolution = resolveSelectedProjectRowRepo({
      row: row('neither', 'acme/mcode'),
      lookupSlugMatches: () => ({ origin: [repo('upstream')], upstream: [repo('fork')] }),
      slugIndexReady: true,
      selectedRepoIds: new Set(['other'])
    })

    expect(resolution).toMatchObject({
      status: 'unselected_match',
      globalMatches: [{ id: 'upstream' }, { id: 'fork' }]
    })
  })
})
