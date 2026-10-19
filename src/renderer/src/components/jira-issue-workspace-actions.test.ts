import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/jira-issue-key-casing', () => ({
  getJiraIssueKeyCasingSeedOptions: () => ({})
}))

import { buildJiraBranchName } from './jira-issue-workspace-actions'

describe('buildJiraBranchName', () => {
  const issue = { key: 'PROJ-123', title: 'Android feature' }

  it('lowercases the whole suggested branch name by default', () => {
    expect(buildJiraBranchName(issue)).toBe('proj-123-android-feature')
    expect(buildJiraBranchName(issue, { jiraIssueKeyCasing: 'lowercase' })).toBe(
      'proj-123-android-feature'
    )
  })

  it('keeps the canonical uppercase key when the casing policy preserves it', () => {
    expect(buildJiraBranchName(issue, { jiraIssueKeyCasing: 'preserve' })).toBe(
      'PROJ-123-android-feature'
    )
    expect(
      buildJiraBranchName({ key: 'TEAM_ALPHA9-7', title: '' }, { jiraIssueKeyCasing: 'preserve' })
    ).toBe('TEAM_ALPHA9-7')
  })
})
