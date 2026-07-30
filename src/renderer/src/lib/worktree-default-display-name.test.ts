import { describe, expect, it } from 'vitest'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'

describe('resolveWorktreeBranchLabel', () => {
  it('strips refs/heads/ like the raw branchName call it replaces', () => {
    expect(resolveWorktreeBranchLabel({ branch: 'refs/heads/feature/jump' })).toBe('feature/jump')
  })

  it('returns empty for a folder workspace, which carries no branch', () => {
    expect(resolveWorktreeBranchLabel({ branch: '' })).toBe('')
  })

  it('returns empty instead of throwing when branch is absent at runtime', () => {
    // The palette renders every row on an empty query, before any branch search runs,
    // so an unguarded branchName() here crashed the whole palette.
    expect(resolveWorktreeBranchLabel({ branch: undefined as unknown as string })).toBe('')
  })
})

describe('resolveWorktreeDisplayName', () => {
  it('prefers the custom name', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: 'Design review',
        branch: 'refs/heads/feature/jump',
        path: '/repos/orca'
      })
    ).toBe('Design review')
  })

  it('falls back to the branch when the name was blanked to an empty string', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: '',
        branch: 'refs/heads/feature/jump',
        path: '/repos/orca'
      })
    ).toBe('feature/jump')
  })

  it('treats a whitespace-only name as blank', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: '   ',
        branch: 'refs/heads/main',
        path: '/repos/orca'
      })
    ).toBe('main')
  })

  it('falls back to the branch when a cleared name left the field undefined', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: undefined as unknown as string,
        branch: 'refs/heads/main',
        path: '/repos/orca'
      })
    ).toBe('main')
  })

  it('falls back to the folder name for a branch-less folder workspace', () => {
    expect(
      resolveWorktreeDisplayName({ displayName: '', branch: '', path: '/repos/design-review' })
    ).toBe('design-review')
  })

  it('resolves the folder name from a Windows path', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: '',
        branch: '',
        path: 'C:\\Users\\alice\\repos\\design-review'
      })
    ).toBe('design-review')
  })

  it('keeps emoji and non-ASCII names intact', () => {
    expect(
      resolveWorktreeDisplayName({ displayName: '🚀 Läufer', branch: '', path: '/repos/x' })
    ).toBe('🚀 Läufer')
  })

  it('returns empty rather than throwing when every source is missing', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: undefined as unknown as string,
        branch: undefined as unknown as string,
        path: undefined as unknown as string
      })
    ).toBe('')
  })
})
