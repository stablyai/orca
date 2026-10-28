import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { readLinkedJiraIssues } from './task-page-jira-linked-issues'
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'app',
  hostId: 'runtime:remote'
}
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  title: 'Fix login',
  siteId: 'a',
  url: 'https://a.example/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'Application' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
describe('Jira Has Workspace issue reads', () => {
  it('reads exact linked keys including closed issues with site/source and refresh scope', async () => {
    const search = vi.fn().mockResolvedValue([issue])
    expect(
      await readLinkedJiraIssues(
        [{ key: 'APP-1', siteId: 'a', sourceContext: source }],
        search,
        null,
        true
      )
    ).toEqual({ issues: [issue], error: null, jqlRejection: null })
    expect(search).toHaveBeenCalledWith('key = APP-1', 1, {
      sourceContext: source,
      siteId: 'a',
      force: true
    })
  })
  it('keeps successful reads when another site fails and reports the failure', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([issue])
      .mockRejectedValueOnce(new Error('Site unavailable'))
    const result = await readLinkedJiraIssues(
      [
        { key: 'APP-1', siteId: 'a' },
        { key: 'APP-2', siteId: 'b' }
      ],
      search,
      source,
      false
    )
    expect(result.issues).toEqual([issue])
    expect(result.error).not.toBeNull()
  })
  it('does not accept a same-key result from the wrong Jira site', async () => {
    const search = vi.fn().mockResolvedValue([{ ...issue, siteId: 'other' }])
    const result = await readLinkedJiraIssues(
      [{ key: 'APP-1', siteId: 'a' }],
      search,
      source,
      false
    )
    expect(result.issues).toEqual([])
    expect(result.error).not.toBeNull()
  })
})
