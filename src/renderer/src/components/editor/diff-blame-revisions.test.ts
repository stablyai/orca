import { describe, expect, it } from 'vitest'
import { GIT_BLAME_HEAD_REVISION } from '../../../../shared/git-blame'
import { getCombinedSectionBlameRevisions, getFileDiffBlameRevisions } from './diff-blame-revisions'

const COMMIT = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const BASE = 'd'.repeat(40)

describe('getFileDiffBlameRevisions', () => {
  it('blames HEAD vs the working tree for uncommitted diffs', () => {
    expect(getFileDiffBlameRevisions({ diffSource: 'unstaged' })).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      modifiedRevision: undefined
    })
    expect(getFileDiffBlameRevisions({ diffSource: 'staged' })).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      modifiedRevision: undefined
    })
  })

  it('blames the parent and commit for a commit diff', () => {
    expect(
      getFileDiffBlameRevisions({
        diffSource: 'commit',
        commitCompare: { commitOid: COMMIT, parentOid: PARENT }
      })
    ).toEqual({ originalRevision: PARENT, modifiedRevision: COMMIT })
  })

  it('skips the original side when a commit has no parent', () => {
    expect(
      getFileDiffBlameRevisions({
        diffSource: 'commit',
        commitCompare: { commitOid: COMMIT, parentOid: null }
      })
    ).toEqual({ originalRevision: undefined, modifiedRevision: COMMIT })
  })

  it('blames the merge base and head for a branch diff', () => {
    expect(
      getFileDiffBlameRevisions({
        diffSource: 'branch',
        branchCompare: { mergeBase: BASE, baseOid: BASE, headOid: HEAD }
      })
    ).toEqual({ originalRevision: BASE, modifiedRevision: HEAD })
  })
})

describe('getCombinedSectionBlameRevisions', () => {
  it('treats combined-all rows without an area as branch entries', () => {
    expect(
      getCombinedSectionBlameRevisions({
        diffSource: 'combined-all',
        branchCompare: { mergeBase: BASE, baseOid: BASE, headOid: HEAD }
      })
    ).toEqual({ originalRevision: BASE, modifiedRevision: HEAD })
  })

  it('treats combined-all rows with an area as uncommitted', () => {
    expect(
      getCombinedSectionBlameRevisions({
        diffSource: 'combined-all',
        sectionArea: 'unstaged',
        branchCompare: { mergeBase: BASE, baseOid: BASE, headOid: HEAD }
      })
    ).toEqual({ originalRevision: GIT_BLAME_HEAD_REVISION, modifiedRevision: undefined })
  })
})
