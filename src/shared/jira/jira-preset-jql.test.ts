import { describe, expect, it } from 'vitest'
import { searchJiraPreset } from './jira-preset-jql'
import { restrictJiraQueryToProject } from './jira-project-reference'

const project = { id: '10000', key: 'OLD', name: 'Legacy', siteId: 'legacy' }

describe('searchJiraPreset', () => {
  it('retries a project-scoped preset with resolution when statusCategory is rejected', async () => {
    const queries: string[] = []
    const issues = await searchJiraPreset(
      'reported',
      { statuses: ['In Progress'], currentSprint: true },
      async (jql) => {
        const query = restrictJiraQueryToProject(jql, project)
        queries.push(query)
        if (query.includes('statusCategory')) {
          throw new Error("Error 400: 字段 'statusCategory' 不存在")
        }
        return ['OLD-1']
      }
    )
    expect(issues).toEqual(['OLD-1'])
    expect(queries[1]).toBe(
      'project = "10000" AND (reporter = currentUser() AND resolution = Unresolved AND status in ("In Progress") AND sprint in openSprints()) ORDER BY updated DESC'
    )
  })
})
