// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskPageLinearBoardModel } from '../linear/use-task-page-linear-board'
import { useTaskPageJiraListProjection } from '@/components/task-page/jira/use-task-page-jira-list-projection'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'site-label-project',
  hostId: 'runtime:jira-site-label-owner'
}
const sites: JiraSite[] = [
  {
    id: 'acme',
    siteUrl: 'https://acme.atlassian.net',
    email: 'ada@acme.com',
    displayName: 'Ada Lovelace',
    accountId: 'ada-acme'
  }
]

function nameOnlyIssue(): JiraIssue {
  // Older remote hosts send the profile name alone as siteName.
  return {
    id: 'acme-issue',
    key: 'ACME-1',
    siteId: 'acme',
    siteName: 'Ada Lovelace',
    title: 'Same-name sites stay apart',
    url: 'https://acme.atlassian.net/browse/ACME-1',
    project: { id: 'acme-project', key: 'ACME', name: 'Acme' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: 'todo', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-11-03T09:00:00Z',
    createdAt: '2026-11-03T09:00:00Z'
  }
}

function useProjectionFixture(jiraIssues: JiraIssue[]) {
  const model = {
    accountBackedTaskSourceHostId: 'runtime:jira-site-label-owner',
    jiraTaskSourceContext: source,
    jiraTaskSourceScopeKey: getTaskSourceCacheScope(source),
    jiraHasWorkspace: false,
    appliedJiraSearch: '',
    linearAttachmentWorkspaces: [],
    jiraStatus: { sites },
    selectedJiraSiteId: null,
    jiraCacheSnapshot: { issueCache: {}, searchCache: {} },
    jiraIssues,
    jiraProjectStatusOrder: null,
    jiraOrderBy: 'updated',
    jiraOrderDirection: 'desc',
    jiraPrioritiesBySite: new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the Jira projection, without constructing unrelated provider pipelines.
  return useTaskPageJiraListProjection(model as unknown as TaskPageLinearBoardModel)
}

describe('Jira list projection site labels', () => {
  afterEach(cleanup)

  it('relabels a name-only siteName from its stored site', () => {
    const { result } = renderHook(() => useProjectionFixture([nameOnlyIssue()]))

    expect(result.current.displayedJiraIssues.map((issue) => issue.siteName)).toEqual([
      'Ada Lovelace (acme.atlassian.net)'
    ])
  })
})
