import { describe, expect, it } from 'vitest'
import { describeWorktreeWork, getWorktreeWorkCheck, toUnpushed } from './machine-delete-work'

describe('describeWorktreeWork', () => {
  it('reads one line per worktree, never "No changes" for what it could not check', () => {
    expect(describeWorktreeWork({ uncommitted: 1, unpushed: 1 })).toEqual({
      text: '1 uncommitted · 1 unpushed',
      atRisk: true
    })
    expect(describeWorktreeWork({ uncommitted: 0, unpushed: 0 })).toEqual({
      text: 'No changes',
      atRisk: false
    })
    expect(describeWorktreeWork({ uncommitted: 0, unpushed: 'unknown' }).text).toBe(
      'Couldn’t check unpushed commits'
    )
    expect(describeWorktreeWork({ uncommitted: 'unknown', unpushed: 2 }).text).toBe(
      'Couldn’t check uncommitted changes · 2 unpushed'
    )
    expect(describeWorktreeWork({ uncommitted: 'checking', unpushed: 0 }).text).toBe('Checking…')
    expect(describeWorktreeWork({ uncommitted: 'unknown', unpushed: 'unknown' })).toEqual({
      text: 'Couldn’t check unsaved work',
      atRisk: true
    })
  })

  it('treats a branch with no upstream as never pushed, and a failed read as unknown', () => {
    expect(toUnpushed({ hasUpstream: false, ahead: 0, behind: 0 })).toBe('none')
    expect(toUnpushed(null)).toBe('unknown')
    expect(toUnpushed(undefined)).toBe('checking')
    expect(toUnpushed({ hasUpstream: true, ahead: 3, behind: 0 })).toBe(3)
  })

  it('never says No changes for a stopped machine whose total has a never-pushed branch', () => {
    expect(
      getWorktreeWorkCheck(false, { uncommitted: 0, unpushed: 0, neverPushed: 1 }, null, null)
    ).toBeNull()
  })

  it("gives a stopped machine's rows its server-read total", () => {
    const upstream = { hasUpstream: true, ahead: 1, behind: 0 }
    expect(getWorktreeWorkCheck(true, null, [{}], upstream)).toEqual({
      uncommitted: 1,
      unpushed: 1
    })
    expect(getWorktreeWorkCheck(false, 'checking', [{}], upstream)).toEqual({
      uncommitted: 'checking',
      unpushed: 'checking'
    })
    expect(getWorktreeWorkCheck(false, null, undefined, undefined)).toEqual({
      uncommitted: 'unknown',
      unpushed: 'unknown'
    })
    expect(getWorktreeWorkCheck(false, { uncommitted: 0, unpushed: 0 }, null, null)).toEqual({
      uncommitted: 0,
      unpushed: 0
    })
    expect(getWorktreeWorkCheck(false, { uncommitted: 2, unpushed: 0 }, null, null)).toBeNull()
  })
})
