import { describe, expect, it } from 'vitest'
import { areWorkspaceLinkedItemsEqual } from './workspace-linked-item'
import type { WorkspaceLinkedItem } from './types'

const item: WorkspaceLinkedItem = {
  provider: 'jira',
  type: 'issue',
  number: 0,
  title: 'ORCA-123 Link Jira',
  url: 'https://company.atlassian.net/browse/ORCA-123',
  jiraIdentifier: 'ORCA-123',
  repoId: 'repo-1'
}

describe('areWorkspaceLinkedItemsEqual', () => {
  it('ignores key order and absent-vs-undefined optional fields', () => {
    expect(
      areWorkspaceLinkedItemsEqual(item, {
        repoId: 'repo-1',
        jiraIdentifier: 'ORCA-123',
        url: 'https://company.atlassian.net/browse/ORCA-123',
        title: 'ORCA-123 Link Jira',
        number: 0,
        type: 'issue',
        provider: 'jira',
        linearIdentifier: undefined
      })
    ).toBe(true)
  })

  it('treats both nullish items as equal and a one-sided item as different', () => {
    expect(areWorkspaceLinkedItemsEqual(null, undefined)).toBe(true)
    expect(areWorkspaceLinkedItemsEqual(item, null)).toBe(false)
  })

  it('separates items that differ by identifier, title, url, provider, or repo', () => {
    expect(areWorkspaceLinkedItemsEqual(item, { ...item, jiraIdentifier: 'ORCA-124' })).toBe(false)
    expect(areWorkspaceLinkedItemsEqual(item, { ...item, title: 'Renamed' })).toBe(false)
    expect(areWorkspaceLinkedItemsEqual(item, { ...item, url: 'https://other/browse/X-1' })).toBe(
      false
    )
    expect(areWorkspaceLinkedItemsEqual(item, { ...item, provider: 'github', number: 12 })).toBe(
      false
    )
    expect(areWorkspaceLinkedItemsEqual(item, { ...item, repoId: 'repo-2' })).toBe(false)
  })
})
