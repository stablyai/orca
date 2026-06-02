import { describe, expect, it } from 'vitest'
import {
  getLinearIssueWorkspaceName,
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

describe('getLinearIssueWorkspaceName', () => {
  it('keeps the Linear identifier in the workspace seed', () => {
    expect(
      getLinearIssueWorkspaceName({
        identifier: 'ENG-42',
        title: 'Ship Linear parity'
      })
    ).toBe('eng-42-ship-linear-parity')
  })

  it('does not duplicate an identifier already present in the Linear title', () => {
    expect(
      getLinearIssueWorkspaceName({
        identifier: 'ENG-42',
        title: 'ENG-42 Ship Linear parity'
      })
    ).toBe('eng-42-ship-linear-parity')
  })

  it('keeps the combined Linear seed within the workspace-name limit', () => {
    const seed = getLinearIssueWorkspaceName({
      identifier: 'ENG-42',
      title: 'Implement a very long Linear issue title that should be truncated'
    })
    expect(seed.length).toBeLessThanOrEqual(48)
    expect(seed).toMatch(/^eng-42-/)
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
