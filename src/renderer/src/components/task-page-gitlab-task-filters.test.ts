import { describe, expect, it } from 'vitest'
import { isGitLabIssueFilter, isGitLabMRFilter } from './task-page-source-context'

describe('isGitLabMRFilter', () => {
  it('accepts MR statuses including all', () => {
    expect(isGitLabMRFilter('opened')).toBe(true)
    expect(isGitLabMRFilter('merged')).toBe(true)
    expect(isGitLabMRFilter('closed')).toBe(true)
    expect(isGitLabMRFilter('all')).toBe(true)
  })

  it('rejects issue-only filters', () => {
    expect(isGitLabMRFilter('assigned-to-me')).toBe(false)
  })
})

describe('isGitLabIssueFilter', () => {
  it('accepts issue filters', () => {
    expect(isGitLabIssueFilter('opened')).toBe(true)
    expect(isGitLabIssueFilter('assigned-to-me')).toBe(true)
  })

  it('rejects MR-only filters', () => {
    expect(isGitLabIssueFilter('merged')).toBe(false)
    expect(isGitLabIssueFilter('closed')).toBe(false)
    expect(isGitLabIssueFilter('all')).toBe(false)
  })
})
