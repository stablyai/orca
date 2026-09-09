import { describe, expect, it } from 'vitest'
import type { GitStashSummary } from '../../../../../../shared/git-stash'
import { retainCurrentStashFiles, stashFilesCacheKey } from './stash-panel-cache'

function stash(ref: string, commitId: string): GitStashSummary {
  return { ref, commitId, author: 'A', email: 'a@example.com', timestamp: 1, summary: ref }
}

describe('stash panel cache identity', () => {
  it('does not reuse files when a mutable stash ref points at another commit', () => {
    const before = stash('stash@{0}', 'a'.repeat(40))
    const after = stash('stash@{0}', 'b'.repeat(40))
    const cache = { [stashFilesCacheKey(before)]: [{ status: 'M', path: 'old.ts' }] }

    expect(stashFilesCacheKey(after)).not.toBe(stashFilesCacheKey(before))
    expect(retainCurrentStashFiles(cache, [after])).toEqual({})
  })
})
