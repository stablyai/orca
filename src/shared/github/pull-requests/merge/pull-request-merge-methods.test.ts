import { describe, expect, it } from 'vitest'
import {
  normalizeGitHubPRMergeMethodSettings,
  resolveGitHubPRMergeMethods
} from './pull-request-merge-methods'

describe('GitHub PR merge methods', () => {
  it('uses GitHub viewer defaults and hides methods disabled by the repository', () => {
    const settings = normalizeGitHubPRMergeMethodSettings({
      defaultMethod: 'REBASE',
      mergeCommitAllowed: false,
      rebaseMergeAllowed: true,
      squashMergeAllowed: true
    })

    expect(resolveGitHubPRMergeMethods(settings)).toEqual({
      defaultMethod: 'rebase',
      methods: ['rebase', 'squash']
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
    expect(resolveGitHubPRMergeMethods(settings).methods).toEqual(['merge'])
  })
})
