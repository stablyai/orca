import { describe, expect, it } from 'vitest'
import { observeParentLoss } from './orchestration-parent-loss'

describe('observeParentLoss', () => {
  it('keeps an active child parent-controlled while its parent is live', () => {
    expect(
      observeParentLoss({ dispatchActive: true, parentSelected: true, parentLive: true })
    ).toEqual({
      parentStatus: 'READY',
      inputPolicy: 'PARENT_ONLY',
      rebindStatus: 'NOT_REQUIRED'
    })
  })

  it('freezes an active child without granting direct input when its parent is lost', () => {
    expect(
      observeParentLoss({ dispatchActive: true, parentSelected: true, parentLive: false })
    ).toEqual({
      parentStatus: 'FROZEN',
      inputPolicy: 'FROZEN',
      rebindStatus: 'APPROVAL_REQUIRED'
    })
  })

  it('does not freeze a settled dispatch', () => {
    expect(
      observeParentLoss({ dispatchActive: false, parentSelected: true, parentLive: false })
    ).toEqual({
      parentStatus: 'READY',
      inputPolicy: 'DIRECT_ALLOWED',
      rebindStatus: 'NOT_REQUIRED'
    })
  })
})
