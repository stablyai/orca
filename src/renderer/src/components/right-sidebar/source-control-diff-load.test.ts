import { describe, expect, it } from 'vitest'
import {
  isSourceControlOpenDiffStaged,
  resolveEditChangesDiffLoadArgs,
  resolveSourceControlDiffLoadArgs
} from './source-control-diff-load'

describe('source-control-diff-load', () => {
  it('opens staged rows as staged diffs (index vs HEAD)', () => {
    expect(resolveSourceControlDiffLoadArgs('staged')).toEqual({
      staged: true,
      compareAgainstHead: false
    })
    expect(isSourceControlOpenDiffStaged('staged')).toBe(true)
  })

  it('opens Changes / unstaged rows as working-tree vs index only', () => {
    expect(resolveSourceControlDiffLoadArgs('unstaged')).toEqual({
      staged: false,
      compareAgainstHead: false
    })
    expect(isSourceControlOpenDiffStaged('unstaged')).toBe(false)
  })

  it('opens untracked rows as unstaged (not staged) without HEAD compare', () => {
    expect(resolveSourceControlDiffLoadArgs('untracked')).toEqual({
      staged: false,
      compareAgainstHead: false
    })
    expect(isSourceControlOpenDiffStaged('untracked')).toBe(false)
  })

  it('treats missing area as unstaged-only', () => {
    expect(resolveSourceControlDiffLoadArgs(undefined)).toEqual({
      staged: false,
      compareAgainstHead: false
    })
    expect(isSourceControlOpenDiffStaged(undefined)).toBe(false)
  })

  it('keeps editor Changes view on the index left side (not HEAD)', () => {
    // Why: HEAD-vs-WT mixed already-staged hunks into remaining Changes work (#11133).
    expect(resolveEditChangesDiffLoadArgs()).toEqual({
      staged: false,
      compareAgainstHead: false
    })
  })
})
