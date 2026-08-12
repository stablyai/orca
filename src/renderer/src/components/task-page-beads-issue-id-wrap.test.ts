import { describe, expect, it } from 'vitest'
import { splitBeadsIssueIdForWrap } from './task-page-beads-issue-id-wrap'

describe('splitBeadsIssueIdForWrap', () => {
  it('splits a long id after its last hyphen, keeping the hyphen on the first line', () => {
    expect(splitBeadsIssueIdForWrap('beads-probe-ay8')).toEqual(['beads-probe-', 'ay8'])
  })

  it('keeps hierarchical child suffixes intact on the second line', () => {
    expect(splitBeadsIssueIdForWrap('orca-4f8a2c.12')).toEqual(['orca-', '4f8a2c.12'])
  })

  it('leaves short ids on one line', () => {
    expect(splitBeadsIssueIdForWrap('bd-12')).toBeNull()
    expect(splitBeadsIssueIdForWrap('orca-42')).toBeNull()
  })

  it('never yields an empty line for edge hyphens or hyphen-less ids', () => {
    expect(splitBeadsIssueIdForWrap('unhyphenated')).toBeNull()
    expect(splitBeadsIssueIdForWrap('-leadinghyphen')).toBeNull()
    expect(splitBeadsIssueIdForWrap('trailinghyphen-')).toBeNull()
  })
})
