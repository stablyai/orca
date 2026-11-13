import { describe, expect, it } from 'vitest'
import { isWorkItemLookupText } from './work-item-lookup-text'

describe('isWorkItemLookupText Jira URLs', () => {
  it('does not claim bare Jira-shaped keys or malformed browse URLs', () => {
    expect(isWorkItemLookupText('ORCA-123')).toBe(false)
    expect(isWorkItemLookupText('https://jira.example.com/browse/ORCA-123/extra')).toBe(false)
  })
})
