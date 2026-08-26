import { describe, expect, it } from 'vitest'
import { EMPTY_CUSTOM_PROVIDER_DRAFT } from './custom-provider-draft'
import { mergeJsonIntoDraft } from './custom-provider-json-view'

describe('mergeJsonIntoDraft key-deletion semantics (#7)', () => {
  const prev = {
    ...EMPTY_CUSTOM_PROVIDER_DRAFT,
    tokenEnvVar: 'MY_TOKEN',
    percentPath: 'a.b',
    usedPaths: ['x', 'y'],
    limitPath: 'limit'
  }

  it('clears tokenEnvVar when the key is deleted from the JSON (absent, not just falsy)', () => {
    const merged = mergeJsonIntoDraft(prev, {})
    expect(merged.tokenEnvVar).toBe('')
  })

  it('keeps the previous tokenEnvVar when the key is present but simply not included in this partial shape update', () => {
    const merged = mergeJsonIntoDraft(prev, { tokenEnvVar: 'OTHER_TOKEN' })
    expect(merged.tokenEnvVar).toBe('OTHER_TOKEN')
  })

  it('clears percentPath/usedPaths/limitPath when their keys are absent', () => {
    const merged = mergeJsonIntoDraft(prev, {})
    expect(merged.percentPath).toBe('')
    expect(merged.usedPaths).toEqual([])
    expect(merged.limitPath).toBe('')
  })

  it('does not resurrect a deleted key on the next re-serialize/merge round trip', () => {
    const afterDeletion = mergeJsonIntoDraft(prev, {})
    const afterSecondMerge = mergeJsonIntoDraft(afterDeletion, {})
    expect(afterSecondMerge.tokenEnvVar).toBe('')
  })
})
