import type { GitHubProjectRow, GitHubProjectTable } from './project-types'

export function projectRelationsTableFixture(): GitHubProjectTable {
  const row = (id: string, position: number, points: number): GitHubProjectRow => ({
    id,
    itemType: 'ISSUE',
    position,
    updatedAt: '',
    content: {
      number: position + 1,
      title: id,
      body: null,
      url: null,
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'acme/repo',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId: { points: { kind: 'number', fieldId: 'points', number: points } }
  })
  const populated = row('populated', 0, 2)
  populated.content.linkedPullRequests = {
    pullRequests: [{ number: 12, title: 'Change', url: 'https://github.com/acme/repo/pull/12' }],
    totalCount: 3
  }
  populated.content.subIssuesProgress = { completed: 1, total: 2, percentCompleted: 50 }
  const points = { kind: 'field', id: 'points', name: 'Points', dataType: 'NUMBER' } as const
  return {
    project: {
      id: 'project-1',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title: 'Roadmap',
      url: 'https://github.com/orgs/acme/projects/1'
    },
    selectedView: {
      id: 'view-1',
      number: 1,
      name: 'Table',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [
        points,
        {
          kind: 'field',
          id: 'prs',
          name: 'Linked pull requests',
          dataType: 'LINKED_PULL_REQUESTS'
        },
        {
          kind: 'field',
          id: 'progress',
          name: 'Sub-issues progress',
          dataType: 'SUB_ISSUES_PROGRESS'
        }
      ],
      groupByFields: [points],
      sortByFields: [{ field: points, direction: 'ASC' }]
    },
    rows: [populated, row('legacy', 1, 1)],
    totalCount: 2,
    parentFieldDropped: false
  }
}
