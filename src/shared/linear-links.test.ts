import { describe, expect, it } from 'vitest'

import { buildLinearTeamUrl, getLinearOrganizationUrlKeyFromIssueUrl } from './linear-links'

describe('linear links', () => {
  it('builds team URLs from workspace and team keys', () => {
    expect(buildLinearTeamUrl({ organizationUrlKey: 'acme', teamKey: 'ENG' })).toBe(
      'https://linear.app/acme/team/ENG/all'
    )
  })

  it('encodes URL path segments', () => {
    expect(buildLinearTeamUrl({ organizationUrlKey: 'acme inc', teamKey: 'A/B' })).toBe(
      'https://linear.app/acme%20inc/team/A%2FB/all'
    )
  })

  it('extracts the workspace URL key from Linear issue URLs', () => {
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/acme/issue/ENG-1')).toBe(
      'acme'
    )
  })
})
