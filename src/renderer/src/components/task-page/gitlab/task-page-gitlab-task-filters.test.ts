import { describe, expect, it, afterEach, vi } from 'vitest'
import { isGitLabIssueFilter, isGitLabMRFilter } from '../../task-page-source-context'

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

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
