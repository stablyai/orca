import { describe, expect, it } from 'vitest'
import {
  reconcileSidebarActiveRowIntent,
  type SidebarActiveRowIntent
} from './sidebar-active-row-intent'

const pendingIntent: SidebarActiveRowIntent = {
  worktreeId: 'worktree-a',
  rowKey: 'group-b:worktree-a',
  navigationIntent: 7
}

describe('sidebar active row intent', () => {
  it('survives a row reorder while its navigation is pending', () => {
    expect(reconcileSidebarActiveRowIntent(pendingIntent, 7, true)).toBe(pendingIntent)
  })

  it('clears when the selected duplicate row is collapsed away', () => {
    expect(reconcileSidebarActiveRowIntent(pendingIntent, 7, false)).toBeNull()
  })

  it('clears when newer page or workspace navigation takes ownership', () => {
    expect(reconcileSidebarActiveRowIntent(pendingIntent, 8, true)).toBeNull()
  })
})
