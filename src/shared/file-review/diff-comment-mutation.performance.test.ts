import { expect, it } from 'vitest'
import type { DiffCommentDeliverySnapshot } from './diff-comment-mutation'
import { createDeliveredDiffCommentMatcher } from './diff-comment-mutation'

function countedRevisions(count: number): {
  revisions: DiffCommentDeliverySnapshot[]
  idReads: () => number
} {
  let reads = 0
  const revisions = Array.from({ length: count }, (_, i): DiffCommentDeliverySnapshot => {
    const id = `n${i}`
    return {
      get id() {
        reads += 1
        return id
      },
      body: 'Sample',
      filePath: 'sample.ts',
      lineNumber: 1
    }
  })
  return { revisions, idReads: () => reads }
}

// PR #51560: cleanup builds a matcher for an empty host reply and for already-sent notes; neither may index.
it.each([300, 3000])('indexes none of %i revisions until the first query', (count) => {
  const { revisions, idReads } = countedRevisions(count)
  const matches = createDeliveredDiffCommentMatcher(revisions)
  expect([].some(matches)).toBe(false)
  expect(idReads()).toBe(0)

  const probe = { id: 'n1', body: 'Sample', filePath: 'sample.ts', lineNumber: 1 }
  expect(matches(probe)).toBe(true)
  expect(matches({ ...probe, body: 'Edited' })).toBe(false)
  // One index build, then lookups that read only the matching revision.
  expect(idReads()).toBeLessThanOrEqual(3 * count)
})
