import { afterEach, expect, it } from 'vitest'
import {
  cachePierreDiff,
  getCachedPierreDiff,
  getPierreDiffCacheIdentity
} from './pierre-diff-cache-identity'
import { buildPierreFileDiff } from './pierre-diff-metadata'

afterEach(() => {
  for (let i = 0; i < 65; i += 1) {
    getPierreDiffCacheIdentity(`drain-${i}`, 'x', 'y')
  }
})

it('keeps cached content and hunks independent of edits in either mounted surface', () => {
  const identity = getPierreDiffCacheIdentity('editable-cache', 'old\n', 'new\n')
  const diff = buildPierreFileDiff({
    path: 'file.ts',
    status: 'modified',
    originalContent: 'old\n',
    modifiedContent: 'new\n',
    parseDiffOptions: {}
  })
  cachePierreDiff(identity, diff)
  diff.additionLines[0] = 'first edit\n'
  diff.hunks[0].hunkContent.length = 0
  const reopened = getCachedPierreDiff(identity)!
  expect(reopened.additionLines).toEqual(['new\n'])
  expect(reopened.hunks[0].hunkContent).toEqual([
    {
      type: 'change',
      additions: 1,
      deletions: 1,
      additionLineIndex: 0,
      deletionLineIndex: 0
    }
  ])
  reopened.additionLines[0] = 'second edit\n'
  reopened.hunks.length = 0
  expect(getCachedPierreDiff(identity)?.additionLines).toEqual(['new\n'])
  expect(getCachedPierreDiff(identity)?.hunks).toHaveLength(1)
  getPierreDiffCacheIdentity('editable-cache', 'old\n', 'external update\n')
  expect(getCachedPierreDiff(identity)).toBeUndefined()
})

it('retains a single oversized identity so remounts reuse the worker cache key', () => {
  const original = 'o'.repeat(4_000_001)
  const first = getPierreDiffCacheIdentity('oversize', original, '')
  expect(getPierreDiffCacheIdentity('oversize', original, '')).toBe(first)
})

it('still evicts older identities once more than one entry exceeds the cap', () => {
  const a = 'a'.repeat(4_000_001)
  const b = 'b'.repeat(4_000_001)
  const firstA = getPierreDiffCacheIdentity('older-oversize', a, '')
  getPierreDiffCacheIdentity('newer-oversize', b, '')
  expect(getPierreDiffCacheIdentity('older-oversize', a, '')).not.toBe(firstA)
})
