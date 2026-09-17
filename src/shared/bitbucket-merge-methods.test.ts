import { describe, expect, it } from 'vitest'
import {
  BITBUCKET_PR_MERGE_METHODS,
  BITBUCKET_PR_MERGE_METHOD_LABELS,
  resolveBitbucketPRMergeMethods
} from './bitbucket-merge-methods'

describe('resolveBitbucketPRMergeMethods', () => {
  it('defaults to merge_commit when no default specified', () => {
    const result = resolveBitbucketPRMergeMethods()
    expect(result.defaultMethod).toBe('merge_commit')
    expect(result.defaultLabel).toBe(BITBUCKET_PR_MERGE_METHOD_LABELS.merge_commit)
    expect(result.methods.map((m) => m.method)).toEqual(BITBUCKET_PR_MERGE_METHODS)
  })

  it('orders the specified defaultMethod first', () => {
    const result = resolveBitbucketPRMergeMethods('fast_forward')
    expect(result.defaultMethod).toBe('fast_forward')
    expect(result.defaultLabel).toBe(BITBUCKET_PR_MERGE_METHOD_LABELS.fast_forward)
    expect(result.methods.map((m) => m.method)).toEqual(['fast_forward', 'merge_commit', 'squash'])
  })

  it('handles squash default', () => {
    const result = resolveBitbucketPRMergeMethods('squash')
    expect(result.defaultMethod).toBe('squash')
    expect(result.methods.map((m) => m.method)).toEqual(['squash', 'merge_commit', 'fast_forward'])
  })
})
