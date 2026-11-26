import { describe, expect, it } from 'vitest'
import { normalizeGitLabMergeMethodSettings } from './pull-request-merge-methods'

const ALL = { squash: true, merge: true, rebase: true }

describe('normalizeGitLabMergeMethodSettings', () => {
  it.each([
    ['always', 'merge', 'squash', ALL],
    ['default_on', 'ff', 'squash', ALL],
    ['default_off', 'merge', 'merge', ALL],
    ['default_off', 'rebase_merge', 'rebase', ALL],
    ['default_off', 'ff', 'rebase', ALL],
    ['never', 'merge', 'merge', { ...ALL, squash: false }],
    ['never', 'ff', 'rebase', { ...ALL, squash: false }]
  ])(
    'squash_option %s with merge_method %s',
    (squashOption, mergeMethod, defaultMethod, allowed) => {
      expect(normalizeGitLabMergeMethodSettings({ squashOption, mergeMethod })).toEqual({
        defaultMethod,
        allowedMethods: allowed
      })
    }
  )

  it('leaves settings unknown when GitLab omits or changes the fields', () => {
    expect(
      normalizeGitLabMergeMethodSettings({ squashOption: undefined, mergeMethod: 'merge' })
    ).toBe(undefined)
    expect(
      normalizeGitLabMergeMethodSettings({ squashOption: 'sometimes', mergeMethod: 'merge' })
    ).toBe(undefined)
  })
})
