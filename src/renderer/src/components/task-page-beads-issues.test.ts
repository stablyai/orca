import { describe, expect, it } from 'vitest'

import type { BeadsIssue } from '../../../shared/beads-types'
import { parseBeadsTaskQuery, withBeadsQualifier } from '../../../shared/beads-task-query'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  deriveTaskPageBeadsFacetOptions,
  filterBeadsIssueRows,
  type TaskPageBeadsIssueRow
} from './task-page-beads-issues'

const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'beads',
  projectId: 'proj-1',
  hostId: LOCAL_EXECUTION_HOST_ID
}

function makeRow(overrides: Partial<BeadsIssue> = {}): TaskPageBeadsIssueRow {
  return {
    issue: {
      id: 'orca-a1',
      title: 'Fix the flux capacitor',
      status: 'open',
      priority: 2,
      issueType: 'task',
      labels: [],
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      dependencyCount: 0,
      dependentCount: 0,
      commentCount: 0,
      ...overrides
    },
    sourceContext
  }
}

describe('filterBeadsIssueRows default type scope', () => {
  const rows = [
    makeRow({ id: 'orca-1', issueType: 'task' }),
    makeRow({ id: 'orca-2', issueType: 'bug' }),
    makeRow({ id: 'orca-3', issueType: 'feature' }),
    makeRow({ id: 'orca-4', issueType: 'chore' }),
    makeRow({ id: 'orca-5', issueType: 'epic' }),
    makeRow({ id: 'orca-6', issueType: 'decision' }),
    makeRow({ id: 'orca-7', issueType: 'milestone' })
  ]

  it('shows only core work types when the query has no type qualifiers', () => {
    const filtered = filterBeadsIssueRows(rows, parseBeadsTaskQuery('is:open'))
    expect(filtered.map((row) => row.issue.issueType)).toEqual(['task', 'bug', 'feature', 'chore'])
  })

  it('applies the default scope to the ready preset too', () => {
    const filtered = filterBeadsIssueRows(rows, parseBeadsTaskQuery('is:ready'))
    expect(filtered.map((row) => row.issue.issueType)).toEqual(['task', 'bug', 'feature', 'chore'])
  })

  it('an explicit is:<type> qualifier overrides the default scope', () => {
    expect(
      filterBeadsIssueRows(rows, parseBeadsTaskQuery('is:decision')).map((row) => row.issue.id)
    ).toEqual(['orca-6'])
    expect(
      filterBeadsIssueRows(rows, parseBeadsTaskQuery('is:epic is:milestone')).map(
        (row) => row.issue.id
      )
    ).toEqual(['orca-5', 'orca-7'])
  })

  it('a type facet selection (withBeadsQualifier) overrides the default scope', () => {
    const query = parseBeadsTaskQuery(withBeadsQualifier('is:open', 'types', ['epic']))
    expect(filterBeadsIssueRows(rows, query).map((row) => row.issue.id)).toEqual(['orca-5'])
  })

  it('still applies the other qualifiers inside the default scope', () => {
    const withLabels = [
      makeRow({ id: 'orca-8', issueType: 'bug', labels: ['infra'] }),
      makeRow({ id: 'orca-9', issueType: 'epic', labels: ['infra'] })
    ]
    const filtered = filterBeadsIssueRows(withLabels, parseBeadsTaskQuery('label:infra'))
    expect(filtered.map((row) => row.issue.id)).toEqual(['orca-8'])
  })
})

describe('deriveTaskPageBeadsFacetOptions', () => {
  it('lists all nine built-in types in facet order plus observed extras', () => {
    const options = deriveTaskPageBeadsFacetOptions([
      makeRow({ issueType: 'custom-kind' }),
      makeRow({ issueType: 'decision' })
    ])
    expect(options.types).toEqual([
      'task',
      'bug',
      'feature',
      'chore',
      'epic',
      'milestone',
      'decision',
      'spike',
      'story',
      'custom-kind'
    ])
  })
})
