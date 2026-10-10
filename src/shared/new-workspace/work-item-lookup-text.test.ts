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

describe('isWorkItemLookupText GitHub numbers', () => {
  it('treats an all-digits value as a deliberate name, not an issue lookup', () => {
    expect(isWorkItemLookupText('1234')).toBe(false)
    expect(isWorkItemLookupText('002')).toBe(false)
    expect(isWorkItemLookupText(' 347 ')).toBe(false)
  })

  it('still treats #123 and issue/PR URLs as lookups', () => {
    expect(isWorkItemLookupText('#1234')).toBe(true)
    expect(isWorkItemLookupText('https://github.com/stablyai/orca/issues/1234')).toBe(true)
    expect(isWorkItemLookupText('https://github.com/stablyai/orca/pull/1234')).toBe(true)
    expect(isWorkItemLookupText('see https://github.com/stablyai/orca/pull/1234.')).toBe(true)
  })

  it('leaves mixed text unchanged', () => {
    expect(isWorkItemLookupText('347-ticket')).toBe(false)
    expect(isWorkItemLookupText('fix 1234 later')).toBe(false)
    expect(isWorkItemLookupText('#12a')).toBe(false)
  })
})
