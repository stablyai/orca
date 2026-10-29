import { describe, expect, it } from 'vitest'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from './git-merge-tree-capability'

describe('isUnsupportedMergeTreeWriteTreeError', () => {
  it.each([
    { stderr: 'fatal: unknown rev --write-tree' },
    { stdout: 'usage: git merge-tree <base-tree> <branch1> <branch2>' },
    new Error("error: unknown option 'write-tree'")
  ])('recognizes old-Git write-tree rejection shapes', (error) => {
    expect(isUnsupportedMergeTreeWriteTreeError(error)).toBe(true)
  })

  it('does not classify an ordinary merge failure as unsupported', () => {
    expect(
      isUnsupportedMergeTreeWriteTreeError({
        stderr: 'fatal: refusing to merge unrelated histories'
      })
    ).toBe(false)
  })

  it('recognizes only an unsupported merge-base option', () => {
    expect(
      isUnsupportedMergeTreeMergeBaseError({
        stderr: "error: unknown option `merge-base'"
      })
    ).toBe(true)
    expect(isUnsupportedMergeTreeMergeBaseError({ stderr: 'fatal: merge-base failed' })).toBe(false)
  })
})
