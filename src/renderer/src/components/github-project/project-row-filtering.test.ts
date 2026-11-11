import { describe, expect, it, vi } from 'vitest'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { filterProjectTableRowsBySelectedRepos } from './project-row-filtering'

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1
  }
}

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

describe('filterProjectTableRowsBySelectedRepos', () => {
  it('keeps draft items and inaccessible content while scoping repository-backed items', () => {
    // Normalized shapes: drafts and restricted items carry no repository or number.
    const drafts = Array.from({ length: 1 }, (_, position): GitHubProjectRow => {
      const base = row(`draft-${position}`, null)
      return {
        ...base,
        itemType: 'DRAFT_ISSUE',
        content: { ...base.content, number: null, state: null, body: 'Draft body' },
        fieldValuesByFieldId: {
          status: {
            kind: 'single-select',
            fieldId: 'status',
            optionId: 'todo',
            name: 'Todo',
            color: 'GRAY'
          }
        },
        position
      }
    })
    const draftTable = table(drafts)
    const lookup = vi.fn(() => originOnly([]))
    expect(filterProjectTableRowsBySelectedRepos(draftTable, lookup, true, new Set())).toBe(
      draftTable
    )
    expect(lookup).not.toHaveBeenCalled()

    const restricted = ['ISSUE', 'PULL_REQUEST'].map((type): GitHubProjectRow => {
      const base = row(`restricted-${type}`, null)
      return {
        ...base,
        itemType: 'REDACTED',
        content: { ...base.content, title: 'Restricted item', number: null, state: null }
      }
    })
    const issue = row('issue', 'acme/orca')
    const pullRequest: GitHubProjectRow = { ...row('pr', 'acme/orca'), itemType: 'PULL_REQUEST' }
    const filtered = filterProjectTableRowsBySelectedRepos(
      table([
        ...drafts,
        ...restricted,
        issue,
        pullRequest,
        row('unselected', 'acme/other'),
        // An older host sends inaccessible Issue/PR content as a blank Issue row.
        row('old-host-blank-issue', null)
      ]),
      (slug) => originOnly([repo(slug === 'acme/orca' ? 'selected' : 'other')]),
      true,
      new Set(['selected'])
    )
    expect(filtered.rows).toEqual([...drafts, ...restricted, issue, pullRequest])
    expect(filtered.totalCount).toBe(5)
  })
})
