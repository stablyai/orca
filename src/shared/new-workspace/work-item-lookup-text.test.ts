import { describe, expect, it } from 'vitest'
import { isWorkItemLookupText } from './work-item-lookup-text'

describe('isWorkItemLookupText Jira URLs', () => {
  it('recognizes absolute Jira browse URLs for auto-name replacement', () => {
    expect(isWorkItemLookupText('https://company.atlassian.net/browse/ORCA-123')).toBe(true)
    expect(isWorkItemLookupText('http://jira.example.com:8080/jira/browse/TEAM_CORE-42')).toBe(true)
  })

  it('does not claim bare Jira-shaped keys or malformed browse URLs', () => {
    expect(isWorkItemLookupText('ORCA-123')).toBe(false)
    expect(isWorkItemLookupText('https://jira.example.com/browse/ORCA-123/extra')).toBe(false)
  })
})
