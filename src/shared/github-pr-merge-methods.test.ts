import { describe, expect, it } from 'vitest'
import {
  normalizeGitHubPRMergeMethodSettings,
  resolveGitHubPRMergeMethods
} from './github-pr-merge-methods'

describe('GitHub PR merge methods', () => {
  it('keeps the historical squash-first fallback when repository metadata is missing', () => {
    expect(resolveGitHubPRMergeMethods()).toEqual({
      defaultMethod: 'squash',
      defaultLabel: 'Squash and merge',
      methods: [
        { method: 'squash', label: 'Squash and merge' },
        { method: 'merge', label: 'Create merge commit' },
        { method: 'rebase', label: 'Rebase and merge' }
      ]
    })
  })

  it('uses GitHub viewer defaults and hides methods disabled by the repository', () => {
    const settings = normalizeGitHubPRMergeMethodSettings({
      defaultMethod: 'REBASE',
      mergeCommitAllowed: false,
      rebaseMergeAllowed: true,
      squashMergeAllowed: true
    })

    expect(resolveGitHubPRMergeMethods(settings)).toEqual({
      defaultMethod: 'rebase',
      defaultLabel: 'Rebase and merge',
      methods: [
        { method: 'rebase', label: 'Rebase and merge' },
        { method: 'squash', label: 'Squash and merge' }
      ]
    })
  })

  it('falls back to an allowed method when GitHub returns a disabled default', () => {
    const settings = normalizeGitHubPRMergeMethodSettings({
      defaultMethod: 'SQUASH',
      mergeCommitAllowed: true,
      rebaseMergeAllowed: false,
      squashMergeAllowed: false
    })

    expect(settings?.defaultMethod).toBe('merge')
    expect(resolveGitHubPRMergeMethods(settings).methods).toEqual([
      { method: 'merge', label: 'Create merge commit' }
    ])
  })
})
