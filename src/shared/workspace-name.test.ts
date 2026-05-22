import { describe, expect, it } from 'vitest'
import {
  getLinkedWorkItemSuggestedName,
  resolveWorkspaceCreateName,
  slugifyForWorkspaceName
} from './workspace-name'

describe('slugifyForWorkspaceName', () => {
  it('keeps workspace seed slugs short, ascii-safe, and git-ref-safe', () => {
    expect(slugifyForWorkspaceName('../../Fix mobile Tasks 🚀')).toBe('fix-mobile-tasks')
    expect(slugifyForWorkspaceName('feature/add issue drawer')).toBe('feature-add-issue-drawer')
    expect(slugifyForWorkspaceName('a'.repeat(80))).toBe('a'.repeat(48))
  })
})

describe('getLinkedWorkItemSuggestedName', () => {
  it('removes duplicated issue and PR numbers from linked titles', () => {
    expect(getLinkedWorkItemSuggestedName({ title: 'Issue #123: Fix mobile Tasks' })).toBe(
      'fix-mobile-tasks'
    )
    expect(getLinkedWorkItemSuggestedName({ title: 'Add mobile drawer (#812)' })).toBe(
      'add-mobile-drawer'
    )
  })
})

describe('resolveWorkspaceCreateName', () => {
  it('preserves explicit user-entered names for the host worktree sanitizer', () => {
    expect(
      resolveWorkspaceCreateName({
        draft: 'feature/something',
        fallback: 'issue-123'
      })
    ).toBe('feature/something')
    expect(
      resolveWorkspaceCreateName({
        draft: '日本語 テスト',
        fallback: 'issue-123'
      })
    ).toBe('日本語 テスト')
  })

  it('uses the stable fallback when the draft is blank', () => {
    expect(resolveWorkspaceCreateName({ draft: '   ', fallback: 'pr-9' })).toBe('pr-9')
    expect(resolveWorkspaceCreateName({ draft: undefined, fallback: 'issue-4' })).toBe('issue-4')
  })
})
