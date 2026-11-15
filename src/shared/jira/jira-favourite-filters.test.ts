import { describe, expect, it } from 'vitest'
import { normalizeJiraFavouriteFilters } from './jira-favourite-filters'

const filter = { id: '123', name: 'My work', jql: 'assignee = currentUser()' }

describe('Jira favourite filter normalization', () => {
  it('keeps only query fields and stamps the authenticated site', () => {
    expect(
      normalizeJiraFavouriteFilters(
        [{ ...filter, siteId: 'foreign-site', owner: { email: 'private@example.com' } }],
        'site-1'
      )
    ).toEqual({ filters: [{ ...filter, siteId: 'site-1' }], truncated: false })
  })
})
