import { describe, expect, it } from 'vitest'
import { canShowWorkspaceDeleteQuickAction } from './workspace-delete-quick-action'

const eligible = {
  deleteModifierPressed: true,
  isDeleting: false,
  isMainWorktree: false,
  isMissionSessionWorkspace: false
}

describe('canShowWorkspaceDeleteQuickAction', () => {
  it('shows delete only while the modifier is held on a deletable row', () => {
    expect(canShowWorkspaceDeleteQuickAction(eligible)).toBe(true)
    expect(canShowWorkspaceDeleteQuickAction({ ...eligible, deleteModifierPressed: false })).toBe(
      false
    )
    expect(canShowWorkspaceDeleteQuickAction({ ...eligible, isDeleting: true })).toBe(false)
    expect(canShowWorkspaceDeleteQuickAction({ ...eligible, isMainWorktree: true })).toBe(false)
  })

  it('never offers delete for a mission session workspace', () => {
    expect(
      canShowWorkspaceDeleteQuickAction({ ...eligible, isMissionSessionWorkspace: true })
    ).toBe(false)
  })
})
