import { describe, expect, it } from 'vitest'
import { GIT_BLAME_HEAD_REVISION, GIT_BLAME_INDEX_CONTENTS } from '../../../../shared/git-blame'
import { getCombinedSectionBlameRevisions, getFileDiffBlameRevisions } from './diff-blame-revisions'

const COMMIT = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const BASE = 'd'.repeat(40)

describe('getFileDiffBlameRevisions', () => {
  it('blames index contents on the unstaged original pane and the working tree on the right', () => {
    expect(getFileDiffBlameRevisions({ diffSource: 'unstaged' })).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      originalContentsSource: GIT_BLAME_INDEX_CONTENTS,
      modifiedRevision: undefined
    })
  })

  it('blames HEAD on the staged original pane and index contents on the right', () => {
    expect(getFileDiffBlameRevisions({ diffSource: 'staged' })).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      modifiedRevision: GIT_BLAME_HEAD_REVISION,
      modifiedContentsSource: GIT_BLAME_INDEX_CONTENTS
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

  it('treats combined-all unstaged rows as index vs working tree', () => {
    expect(
      getCombinedSectionBlameRevisions({
        diffSource: 'combined-all',
        sectionArea: 'unstaged',
        branchCompare: { mergeBase: BASE, baseOid: BASE, headOid: HEAD }
      })
    ).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      originalContentsSource: GIT_BLAME_INDEX_CONTENTS,
      modifiedRevision: undefined
    })
  })

  it('treats combined-all staged rows as HEAD vs index contents', () => {
    expect(
      getCombinedSectionBlameRevisions({
        diffSource: 'combined-all',
        sectionArea: 'staged',
        branchCompare: { mergeBase: BASE, baseOid: BASE, headOid: HEAD }
      })
    ).toEqual({
      originalRevision: GIT_BLAME_HEAD_REVISION,
      modifiedRevision: GIT_BLAME_HEAD_REVISION,
      modifiedContentsSource: GIT_BLAME_INDEX_CONTENTS
    })
  })
})
