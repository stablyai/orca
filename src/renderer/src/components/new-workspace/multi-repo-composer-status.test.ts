import { describe, expect, it } from 'vitest'
import {
  getMultiRepoBranchHelper,
  getMultiRepoCreateBlockedReason,
  getMultiRepoPrimaryActionLabel
} from './multi-repo-composer-status'

describe('multi-repo composer status copy', () => {
  it('explains why Create is blocked, singular and plural', () => {
    expect(getMultiRepoCreateBlockedReason(0)).toBeNull()
    expect(getMultiRepoCreateBlockedReason(1)).toBe('Remove 1 project or switch host')
    expect(getMultiRepoCreateBlockedReason(3)).toBe('Remove 3 projects or switch host')
  })

  it('labels the primary action by project count and pending state', () => {
    expect(getMultiRepoPrimaryActionLabel(3, false)).toBe('Create in 3 projects')
    expect(getMultiRepoPrimaryActionLabel(3, true)).toBe('Creating…')
  })

  it('states the branch rule and how many projects differ', () => {
    expect(getMultiRepoBranchHelper(' flow ', 3, 0)).toBe('Branch flow in all 3 projects')
    expect(getMultiRepoBranchHelper('flow', 3, 1)).toBe('Branch differs in 1 project')
    expect(getMultiRepoBranchHelper('flow', 3, 2)).toBe('Branch differs in 2 projects')
  })
})
